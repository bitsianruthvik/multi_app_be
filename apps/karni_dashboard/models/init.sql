-- karni_dashboard — a read-only dashboard over a company's SAP Business One.
-- Not run by the loader; apply by hand (local and TiDB). Safe to re-run.
--
-- SAP is never written to. The data arrives from a connector that runs inside
-- the customer's network (connector/run.ps1), reads the Service Layer with GET
-- only, and pushes rows here.

-- §1 Connectors: a machine that pushes SAP data. It registers itself with a
-- secret it made (we keep only the hash) and waits until an admin approves it.
CREATE TABLE IF NOT EXISTS kd_connectors (
  id            BIGINT AUTO_INCREMENT PRIMARY KEY,
  company_id    BIGINT       NOT NULL,
  connector_uid VARCHAR(64)  NOT NULL,
  secret_hash   CHAR(64)     NOT NULL,
  machine       VARCHAR(120) NULL,
  win_user      VARCHAR(120) NULL,
  status        VARCHAR(16)  NOT NULL DEFAULT 'pending',  -- pending | approved | revoked
  approved_by   BIGINT       NULL,
  approved_at   DATETIME     NULL,
  last_seen_at  DATETIME     NULL,
  created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_kd_connector_uid (connector_uid),
  KEY ix_kd_connectors_company (company_id, status)
);

-- §2 The SAP rows, one per record, as the Service Layer returned them.
CREATE TABLE IF NOT EXISTS kd_rows (
  company_id BIGINT       NOT NULL,
  dataset    VARCHAR(40)  NOT NULL,
  sap_key    VARCHAR(120) NOT NULL,
  doc_date   DATE         NULL,
  data       JSON         NOT NULL,
  synced_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (company_id, dataset, sap_key),
  KEY ix_kd_rows_date (company_id, dataset, doc_date)
);

-- §3 Where each dataset's sync has got to: the next run asks SAP only for what changed since.
CREATE TABLE IF NOT EXISTS kd_dataset_state (
  company_id   BIGINT      NOT NULL,
  dataset      VARCHAR(40) NOT NULL,
  since_date   DATE        NULL,
  last_ok_at   DATETIME    NULL,
  last_error   TEXT        NULL,
  last_rows    INT         NULL,
  PRIMARY KEY (company_id, dataset)
);

-- §4 One row per connector run, for the Connection screen.
CREATE TABLE IF NOT EXISTS kd_sync_runs (
  id           BIGINT AUTO_INCREMENT PRIMARY KEY,
  company_id   BIGINT   NOT NULL,
  connector_id BIGINT   NOT NULL,
  started_at   DATETIME NOT NULL,
  finished_at  DATETIME NULL,
  ok           TINYINT  NOT NULL DEFAULT 0,
  summary      JSON     NULL,
  KEY ix_kd_runs_company (company_id, started_at)
);

SELECT 'SCHEMA-OK' AS karni_dashboard;
