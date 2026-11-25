-- Shared by MySQL and MariaDB. Runs as root against quicksilver_dev.

CREATE TABLE accounts (
    id          BIGINT AUTO_INCREMENT PRIMARY KEY,
    email       VARCHAR(255) NOT NULL UNIQUE,
    name        VARCHAR(255) NULL,
    country     CHAR(2) NULL,
    created_at  DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    settings    JSON NULL
) CHARACTER SET utf8mb4;

CREATE TABLE orders (
    id          BIGINT AUTO_INCREMENT PRIMARY KEY,
    account_id  BIGINT NOT NULL,
    status      ENUM('pending', 'paid', 'refunded') NOT NULL,
    total       DECIMAL(12, 2) NOT NULL,
    placed_on   DATE NOT NULL,
    note        TEXT NULL,
    CONSTRAINT orders_account_fk FOREIGN KEY (account_id) REFERENCES accounts (id)
) CHARACTER SET utf8mb4;

CREATE TABLE audit_log (
    at      DATETIME NOT NULL,
    actor   VARCHAR(64) NULL,
    action  VARCHAR(64) NOT NULL
);

INSERT INTO accounts (email, name, country, settings) VALUES
    ('user1@example.com', 'User 1', 'IN', '{"theme": "dark"}'),
    ('user2@example.com', NULL, 'US', NULL),
    ('emoji@example.com', 'Ravi 🚀 Kumar', 'IN', '{}'),
    ('naïve@example.com', 'Zoë Ångström', 'SE', '{}');

INSERT INTO orders (account_id, status, total, placed_on, note) VALUES
    (1, 'paid', 120.50, '2025-03-01', NULL),
    (1, 'pending', 9.99, '2025-03-02', 'gift wrap'),
    (2, 'refunded', 45.00, '2025-03-03', NULL),
    (3, 'paid', 300.00, '2025-03-04', NULL);

INSERT INTO audit_log VALUES
    ('2025-06-01 00:00:00', 'ops', 'duplicate'),
    ('2025-06-01 00:00:00', 'ops', 'duplicate');

CREATE DATABASE IF NOT EXISTS analytics;
GRANT ALL PRIVILEGES ON analytics.* TO 'quicksilver'@'%';
