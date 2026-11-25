//! Networking for Quicksilver.
//!
//! TLS and password-command auth today. SSH tunnels through the system
//! `ssh` and AWS SSM tunnels arrive in phase 8.

pub mod password_command;
pub mod tls;
