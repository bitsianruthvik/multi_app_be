-- sumangal_dashboard — rows made from a snapshot of the company's ERP.
-- Not run by the loader; apply by hand or with scripts/setup.mjs (local and TiDB). Safe to re-run.

-- §1 One JSON row per fact; the dataset names are in services/reportService.js.
-- scripts/load-facts.mjs replaces a company's rows as a whole.
CREATE TABLE IF NOT EXISTS sd_rows (
  id         BIGINT AUTO_INCREMENT PRIMARY KEY,
  company_id BIGINT      NOT NULL,
  dataset    VARCHAR(20) NOT NULL,
  data       JSON        NOT NULL,
  KEY idx_sd_company_dataset (company_id, dataset)
);

-- §2 The ERP agent: a small program on the customer's own network that reads the ERP (read-only) each night,
-- builds the ERP dashboard (V15) dataset there and pushes it here (routes/agent.js). It proves itself with a key
-- it made at setup; only the SHA-256 is kept, and nothing is accepted until an admin approves it.
CREATE TABLE IF NOT EXISTS sd_agents (
  id            BIGINT AUTO_INCREMENT PRIMARY KEY,
  company_id    BIGINT       NOT NULL,
  agent_uid     VARCHAR(64)  NOT NULL,
  key_hash      CHAR(64)     NOT NULL,
  machine       VARCHAR(120) NULL,
  win_user      VARCHAR(120) NULL,
  status        VARCHAR(12)  NOT NULL DEFAULT 'pending',
  created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  approved_at   DATETIME     NULL,
  approved_by   BIGINT       NULL,
  last_seen_at  DATETIME     NULL,
  last_run_at   DATETIME     NULL,
  last_ok       TINYINT      NULL,
  last_message  VARCHAR(500) NULL,
  last_seconds  INT          NULL,
  UNIQUE KEY uq_sd_agents_uid (agent_uid),
  KEY idx_sd_agents_company (company_id)
);

-- §3 Refresh requests for the ERP agent: "Refresh now" on the dashboard adds one; the agent, in day mode, waits for
-- them (GET /agent/jobs long-poll), runs an update and closes it. Old rows can be cleared at any time.
CREATE TABLE IF NOT EXISTS sd_agent_jobs (
  id            BIGINT AUTO_INCREMENT PRIMARY KEY,
  company_id    BIGINT       NOT NULL,
  kind          VARCHAR(20)  NOT NULL DEFAULT 'refresh',
  status        VARCHAR(12)  NOT NULL DEFAULT 'waiting',
  requested_by  BIGINT       NULL,
  created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  picked_at     DATETIME     NULL,
  picked_by     BIGINT       NULL,
  done_at       DATETIME     NULL,
  ok            TINYINT      NULL,
  KEY idx_sd_agent_jobs_company (company_id, status)
);
