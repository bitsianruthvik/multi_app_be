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

-- §5 Insight findings: one row per rule + subject (a customer, an item, an order line…),
-- so a finding keeps its identity while its numbers move. status: new | open | done |
-- snoozed | muted ("not relevant") | resolved (gone from the data). acted_* is the value
-- when someone marked it, so it returns only when it gets materially worse.
CREATE TABLE IF NOT EXISTS kd_insight_state (
  company_id    BIGINT       NOT NULL,
  rule_id       VARCHAR(40)  NOT NULL,
  subject_key   VARCHAR(120) NOT NULL,
  subject_label VARCHAR(200) NULL,
  status        VARCHAR(12)  NOT NULL DEFAULT 'new',
  reason        VARCHAR(80)  NULL,
  metric        DOUBLE       NULL,
  band          INT          NULL,
  first_seen_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  resolved_at   DATETIME     NULL,
  acted_by      BIGINT       NULL,
  acted_by_name VARCHAR(120) NULL,
  acted_at      DATETIME     NULL,
  acted_metric  DOUBLE       NULL,
  acted_band    INT          NULL,
  snooze_until  DATETIME     NULL,
  note          VARCHAR(500) NULL,
  notified_at   DATETIME     NULL,
  PRIMARY KEY (company_id, rule_id, subject_key),
  KEY ix_kd_insight_status (company_id, status)
);

-- §6 Every action on a finding, and every automatic change of state.
CREATE TABLE IF NOT EXISTS kd_insight_log (
  id          BIGINT AUTO_INCREMENT PRIMARY KEY,
  company_id  BIGINT       NOT NULL,
  rule_id     VARCHAR(40)  NOT NULL,
  subject_key VARCHAR(120) NOT NULL,
  action      VARCHAR(20)  NOT NULL,
  by_user     BIGINT       NULL,
  by_name     VARCHAR(120) NULL,
  at          DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  metric      DOUBLE       NULL,
  note        VARCHAR(500) NULL,
  KEY ix_kd_insight_log (company_id, rule_id, subject_key, at)
);

-- §7 Alerts sent (or prepared) to people: instant, daily and weekly.
CREATE TABLE IF NOT EXISTS kd_alerts (
  id           BIGINT AUTO_INCREMENT PRIMARY KEY,
  company_id   BIGINT       NOT NULL,
  kind         VARCHAR(10)  NOT NULL,
  area         VARCHAR(20)  NOT NULL,
  title        VARCHAR(300) NOT NULL,
  items        JSON         NOT NULL,
  recipients   JSON         NULL,
  email_status VARCHAR(20)  NOT NULL,
  error        TEXT         NULL,
  created_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY ix_kd_alerts (company_id, created_at)
);

-- §8 Per-company settings (alert recipients, times).
CREATE TABLE IF NOT EXISTS kd_settings (
  company_id BIGINT      NOT NULL,
  k          VARCHAR(40) NOT NULL,
  v          JSON        NOT NULL,
  updated_by BIGINT      NULL,
  updated_at DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (company_id, k)
);

SELECT 'SCHEMA-OK' AS karni_dashboard;
