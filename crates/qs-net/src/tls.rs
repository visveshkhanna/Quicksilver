//! TLS client configuration with libpq's `sslmode` meanings.
//!
//! | mode          | encrypted          | chain verified | host name verified |
//! |---------------|--------------------|----------------|--------------------|
//! | `disable`     | no                 | –              | –                  |
//! | `allow`       | refused, see below | –              | –                  |
//! | `prefer`      | if the server can  | no             | no                 |
//! | `require`     | yes                | only with a root certificate | no   |
//! | `verify-ca`   | yes                | yes            | no                 |
//! | `verify-full` | yes                | yes            | yes                |
//!
//! `allow` tries plaintext first and would send a password in the clear to any
//! server that accepts it, so it is refused by name rather than treated as
//! something else.

use std::path::Path;
use std::sync::Arc;

use qs_core::{Error, Result, SslMode};
use rustls::client::WebPkiServerVerifier;
use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::crypto::{CryptoProvider, WebPkiSupportedAlgorithms};
use rustls::pki_types::pem::PemObject;
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::{
    CertificateError, ClientConfig, DigitallySignedStruct, RootCertStore, SignatureScheme,
};

/// The TLS configuration for `mode`, or `None` when the connection must be
/// plaintext.
///
/// `root_cert` is a PEM file of certificates to trust instead of the OS
/// trust store. Given with `require`, it makes the mode verify the chain, as
/// libpq does.
pub fn client_config(mode: SslMode, root_cert: Option<&Path>) -> Result<Option<Arc<ClientConfig>>> {
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let verifier: Arc<dyn ServerCertVerifier> = match mode {
        SslMode::Disable => return Ok(None),
        SslMode::Allow => {
            return Err(Error::tls(
                "sslmode \"allow\" is not supported: it tries plaintext first and would send the \
                 password unencrypted to any server that accepts it. Use \"prefer\", \"require\", \
                 \"verify-ca\" or \"verify-full\".",
            ));
        }
        SslMode::Prefer => Arc::new(AcceptAnyCertificate::new(&provider)),
        SslMode::Require if root_cert.is_none() => Arc::new(AcceptAnyCertificate::new(&provider)),
        SslMode::Require | SslMode::VerifyCa => {
            Arc::new(ChainOnly(webpki_verifier(root_cert, &provider)?))
        }
        SslMode::VerifyFull => webpki_verifier(root_cert, &provider)?,
    };

    let config = ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .map_err(|err| Error::tls(format!("TLS setup failed: {err}")))?
        .dangerous()
        .with_custom_certificate_verifier(verifier)
        .with_no_client_auth();
    Ok(Some(Arc::new(config)))
}

fn webpki_verifier(
    root_cert: Option<&Path>,
    provider: &Arc<CryptoProvider>,
) -> Result<Arc<WebPkiServerVerifier>> {
    let roots = match root_cert {
        Some(path) => roots_from_file(path)?,
        None => native_roots()?,
    };
    WebPkiServerVerifier::builder_with_provider(Arc::new(roots), provider.clone())
        .build()
        .map_err(|err| Error::tls(format!("TLS setup failed: {err}")))
}

fn roots_from_file(path: &Path) -> Result<RootCertStore> {
    let shown = path.display();
    let certs = CertificateDer::pem_file_iter(path)
        .map_err(|err| Error::tls(format!("cannot read root certificate {shown}: {err}")))?
        .collect::<std::result::Result<Vec<_>, _>>()
        .map_err(|err| Error::tls(format!("cannot read root certificate {shown}: {err}")))?;
    if certs.is_empty() {
        return Err(Error::tls(format!("{shown} holds no PEM certificates")));
    }
    let mut roots = RootCertStore::empty();
    for cert in certs {
        roots
            .add(cert)
            .map_err(|err| Error::tls(format!("{shown} holds an unusable certificate: {err}")))?;
    }
    Ok(roots)
}

fn native_roots() -> Result<RootCertStore> {
    let found = rustls_native_certs::load_native_certs();
    let mut roots = RootCertStore::empty();
    let (added, _ignored) = roots.add_parsable_certificates(found.certs);
    if added == 0 {
        let reason = found
            .errors
            .first()
            .map(|err| format!(": {err}"))
            .unwrap_or_default();
        return Err(Error::tls(format!(
            "no trusted root certificates were found in the system trust store{reason}"
        )));
    }
    Ok(roots)
}

/// Encrypts without verifying the certificate: `prefer`, and `require` with
/// no root certificate. Handshake signatures are still checked, so the
/// session is bound to the certificate the server presented.
#[derive(Debug)]
struct AcceptAnyCertificate {
    algorithms: WebPkiSupportedAlgorithms,
}

impl AcceptAnyCertificate {
    fn new(provider: &CryptoProvider) -> Self {
        AcceptAnyCertificate {
            algorithms: provider.signature_verification_algorithms,
        }
    }
}

impl ServerCertVerifier for AcceptAnyCertificate {
    fn verify_server_cert(
        &self,
        _end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp_response: &[u8],
        _now: UnixTime,
    ) -> std::result::Result<ServerCertVerified, rustls::Error> {
        Ok(ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> std::result::Result<HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls12_signature(message, cert, dss, &self.algorithms)
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> std::result::Result<HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls13_signature(message, cert, dss, &self.algorithms)
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.algorithms.supported_schemes()
    }
}

/// `verify-ca`: the full WebPKI check, except that a certificate issued for
/// another host name is accepted. WebPKI verifies the chain before the name,
/// so a name error means the chain already passed.
#[derive(Debug)]
struct ChainOnly(Arc<WebPkiServerVerifier>);

impl ServerCertVerifier for ChainOnly {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        intermediates: &[CertificateDer<'_>],
        server_name: &ServerName<'_>,
        ocsp_response: &[u8],
        now: UnixTime,
    ) -> std::result::Result<ServerCertVerified, rustls::Error> {
        match self
            .0
            .verify_server_cert(end_entity, intermediates, server_name, ocsp_response, now)
        {
            Err(rustls::Error::InvalidCertificate(
                CertificateError::NotValidForName | CertificateError::NotValidForNameContext { .. },
            )) => Ok(ServerCertVerified::assertion()),
            other => other,
        }
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> std::result::Result<HandshakeSignatureValid, rustls::Error> {
        self.0.verify_tls12_signature(message, cert, dss)
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> std::result::Result<HandshakeSignatureValid, rustls::Error> {
        self.0.verify_tls13_signature(message, cert, dss)
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.0.supported_verify_schemes()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn disable_means_no_tls() {
        assert!(client_config(SslMode::Disable, None).expect("ok").is_none());
    }

    #[test]
    fn allow_is_refused_by_name() {
        let err = client_config(SslMode::Allow, None).expect_err("refused");
        assert!(matches!(err, Error::Tls { .. }));
        assert!(err.to_string().contains("\"allow\""));
    }

    #[test]
    fn encrypting_modes_build_a_config() {
        for mode in [
            SslMode::Prefer,
            SslMode::Require,
            SslMode::VerifyCa,
            SslMode::VerifyFull,
        ] {
            // The verify modes read the OS trust store, which every CI runner has.
            assert!(
                client_config(mode, None).expect("builds").is_some(),
                "{mode}"
            );
        }
    }

    #[test]
    fn a_missing_root_certificate_is_an_error_not_a_fallback() {
        for mode in [SslMode::Require, SslMode::VerifyCa, SslMode::VerifyFull] {
            let err = client_config(mode, Some(Path::new("/definitely/not/here.pem")))
                .expect_err("fails");
            assert!(err.to_string().contains("not/here.pem"), "{mode}: {err}");
        }
    }

    #[test]
    fn a_root_file_without_certificates_is_an_error() {
        let dir = std::env::temp_dir().join(format!("qs-net-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        let empty = dir.join("empty.pem");
        std::fs::write(&empty, "not a certificate\n").expect("write");
        let err = client_config(SslMode::VerifyFull, Some(&empty)).expect_err("fails");
        assert!(err.to_string().contains("no PEM certificates"), "{err}");
        let _ = std::fs::remove_dir_all(dir);
    }
}
