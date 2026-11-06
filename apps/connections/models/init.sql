-- connections — a company's read-only links to outside data.
-- Not run by the loader; apply by hand (local and TiDB). Safe to re-run.

-- §1 One row per link. `config` is what the provider needs in the clear (a folder
-- address, a client id); `secret_enc` is the rest, AES-256-GCM (lib/secrets.js).
-- `resolved` is what the last good test found (for OneDrive, the drive and folder ids).
CREATE TABLE IF NOT EXISTS conn_connections (
  id              BIGINT AUTO_INCREMENT PRIMARY KEY,
  company_id      BIGINT       NOT NULL,
  provider        VARCHAR(40)  NOT NULL,
  name            VARCHAR(120) NOT NULL,
  config          JSON         NOT NULL,
  secret_enc      TEXT         NULL,
  resolved        JSON         NULL,
  status          VARCHAR(16)  NOT NULL DEFAULT 'untested',  -- untested | ok | error
  last_error      VARCHAR(500) NULL,
  last_checked_at DATETIME     NULL,
  created_by      BIGINT       NULL,
  created_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  deleted_at      DATETIME     NULL,
  KEY idx_conn_company (company_id, deleted_at)
);
