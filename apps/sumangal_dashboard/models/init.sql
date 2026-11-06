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
