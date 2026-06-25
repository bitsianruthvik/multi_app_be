-- FabFlow Capacity-Ready Planning migration.
-- Run once against sqldb after init.sql has been applied.
-- Safe to re-run: uses INFORMATION_SCHEMA guards via stored procedures.

DROP PROCEDURE IF EXISTS fab_add_col;
DELIMITER $$
CREATE PROCEDURE fab_add_col(tbl VARCHAR(64), col VARCHAR(64), def TEXT)
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = tbl AND COLUMN_NAME = col
  ) THEN
    SET @sql = CONCAT('ALTER TABLE `', tbl, '` ADD COLUMN `', col, '` ', def);
    PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
  END IF;
END$$
DELIMITER ;

-- ── 1. Alter fab_project_plans ────────────────────────────────────────────────
CALL fab_add_col('fab_project_plans','calendar_id',        'INT DEFAULT NULL AFTER notes');
CALL fab_add_col('fab_project_plans','planned_start_date', 'DATE DEFAULT NULL AFTER calendar_id');
CALL fab_add_col('fab_project_plans','target_end_date',    'DATE DEFAULT NULL AFTER planned_start_date');
CALL fab_add_col('fab_project_plans','scheduling_mode',    "VARCHAR(50) DEFAULT 'Forward' AFTER target_end_date");

-- ── 2. Alter fab_process_steps ────────────────────────────────────────────────
CALL fab_add_col('fab_process_steps','requires_work_area',           'TINYINT(1) DEFAULT 0 AFTER notes');
CALL fab_add_col('fab_process_steps','preferred_work_area_id',       'INT DEFAULT NULL AFTER requires_work_area');
CALL fab_add_col('fab_process_steps','requires_machine',             'TINYINT(1) DEFAULT 0 AFTER preferred_work_area_id');
CALL fab_add_col('fab_process_steps','estimated_machine_time_value', 'DECIMAL(10,2) DEFAULT NULL AFTER requires_machine');
CALL fab_add_col('fab_process_steps','estimated_machine_time_unit',  "VARCHAR(20) DEFAULT 'hr' AFTER estimated_machine_time_value");
CALL fab_add_col('fab_process_steps','resource_notes',               'TEXT DEFAULT NULL AFTER estimated_machine_time_unit');

-- ── 3. Alter fab_nodes ────────────────────────────────────────────────────────
CALL fab_add_col('fab_nodes','preferred_work_area_id','INT DEFAULT NULL AFTER dispatchable');

DROP PROCEDURE IF EXISTS fab_add_col;

-- ── 4. New master tables ──────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS fab_work_calendars (
  id             INT AUTO_INCREMENT PRIMARY KEY,
  company_id     INT          NOT NULL,
  calendar_code  VARCHAR(100) NOT NULL,
  calendar_name  VARCHAR(255) NOT NULL,
  description    TEXT         DEFAULT NULL,
  active         TINYINT(1)   DEFAULT 1,
  deleted_at     DATETIME     DEFAULT NULL,
  created_at     TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
  updated_at     TIMESTAMP    DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (company_id) REFERENCES companies(id),
  UNIQUE KEY uq_fwc_company_code (company_id, calendar_code),
  KEY idx_fwc_company (company_id)
);

CREATE TABLE IF NOT EXISTS fab_work_calendar_days (
  id             INT AUTO_INCREMENT PRIMARY KEY,
  calendar_id    INT          NOT NULL,
  company_id     INT          NOT NULL,
  day_of_week    ENUM('Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday') NOT NULL,
  is_working_day TINYINT(1)   DEFAULT 1,
  start_time     VARCHAR(10)  DEFAULT NULL,
  end_time       VARCHAR(10)  DEFAULT NULL,
  working_hours  DECIMAL(5,2) DEFAULT 0,
  created_at     TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
  updated_at     TIMESTAMP    DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (calendar_id) REFERENCES fab_work_calendars(id),
  FOREIGN KEY (company_id)  REFERENCES companies(id),
  UNIQUE KEY uq_fwcd_cal_day (calendar_id, day_of_week),
  KEY idx_fwcd_calendar (calendar_id)
);

CREATE TABLE IF NOT EXISTS fab_work_calendar_exceptions (
  id             INT AUTO_INCREMENT PRIMARY KEY,
  calendar_id    INT          NOT NULL,
  company_id     INT          NOT NULL,
  exception_date DATE         NOT NULL,
  exception_name VARCHAR(255) DEFAULT NULL,
  is_working_day TINYINT(1)   DEFAULT 0,
  start_time     VARCHAR(10)  DEFAULT NULL,
  end_time       VARCHAR(10)  DEFAULT NULL,
  working_hours  DECIMAL(5,2) DEFAULT 0,
  notes          TEXT         DEFAULT NULL,
  created_at     TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
  updated_at     TIMESTAMP    DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (calendar_id) REFERENCES fab_work_calendars(id),
  FOREIGN KEY (company_id)  REFERENCES companies(id),
  UNIQUE KEY uq_fwce_cal_date (calendar_id, exception_date),
  KEY idx_fwce_calendar (calendar_id)
);

CREATE TABLE IF NOT EXISTS fab_work_areas (
  id                INT AUTO_INCREMENT PRIMARY KEY,
  company_id        INT          NOT NULL,
  work_area_code    VARCHAR(100) NOT NULL,
  work_area_name    VARCHAR(255) NOT NULL,
  area_type         VARCHAR(100) DEFAULT NULL,
  max_parallel_jobs INT          DEFAULT 1,
  calendar_id       INT          DEFAULT NULL,
  active            TINYINT(1)   DEFAULT 1,
  notes             TEXT         DEFAULT NULL,
  deleted_at        DATETIME     DEFAULT NULL,
  created_at        TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
  updated_at        TIMESTAMP    DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (company_id)  REFERENCES companies(id),
  FOREIGN KEY (calendar_id) REFERENCES fab_work_calendars(id),
  UNIQUE KEY uq_fwa_company_code (company_id, work_area_code),
  KEY idx_fwa_company (company_id)
);

CREATE TABLE IF NOT EXISTS fab_work_area_capabilities (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  work_area_id  INT          NOT NULL,
  company_id    INT          NOT NULL,
  process_type  VARCHAR(100) NOT NULL,
  allowed       TINYINT(1)   DEFAULT 1,
  priority      INT          DEFAULT 1,
  notes         TEXT         DEFAULT NULL,
  created_at    TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMP    DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (work_area_id) REFERENCES fab_work_areas(id),
  FOREIGN KEY (company_id)   REFERENCES companies(id),
  UNIQUE KEY uq_fwac_area_type (work_area_id, process_type),
  KEY idx_fwac_area (work_area_id)
);

CREATE TABLE IF NOT EXISTS fab_machines (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  company_id    INT          NOT NULL,
  machine_code  VARCHAR(100) NOT NULL,
  machine_name  VARCHAR(255) NOT NULL,
  machine_type  VARCHAR(100) DEFAULT NULL,
  work_area_id  INT          DEFAULT NULL,
  calendar_id   INT          DEFAULT NULL,
  active        TINYINT(1)   DEFAULT 1,
  notes         TEXT         DEFAULT NULL,
  deleted_at    DATETIME     DEFAULT NULL,
  created_at    TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMP    DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (company_id)   REFERENCES companies(id),
  FOREIGN KEY (work_area_id) REFERENCES fab_work_areas(id),
  FOREIGN KEY (calendar_id)  REFERENCES fab_work_calendars(id),
  UNIQUE KEY uq_fm_company_code (company_id, machine_code),
  KEY idx_fm_company (company_id),
  KEY idx_fm_work_area (work_area_id)
);

CREATE TABLE IF NOT EXISTS fab_machine_capabilities (
  id                     INT AUTO_INCREMENT PRIMARY KEY,
  machine_id             INT          NOT NULL,
  company_id             INT          NOT NULL,
  process_type           VARCHAR(100) NOT NULL,
  capacity_hours_per_day DECIMAL(5,2) DEFAULT 10,
  priority               INT          DEFAULT 1,
  notes                  TEXT         DEFAULT NULL,
  created_at             TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
  updated_at             TIMESTAMP    DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (machine_id) REFERENCES fab_machines(id),
  FOREIGN KEY (company_id) REFERENCES companies(id),
  UNIQUE KEY uq_fmc_machine_type (machine_id, process_type),
  KEY idx_fmc_machine (machine_id)
);

CREATE TABLE IF NOT EXISTS fab_process_work_area_options (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  process_step_id INT NOT NULL,
  work_area_id    INT NOT NULL,
  company_id      INT NOT NULL,
  priority        INT DEFAULT 1,
  notes           TEXT DEFAULT NULL,
  created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (process_step_id) REFERENCES fab_process_steps(id),
  FOREIGN KEY (work_area_id)    REFERENCES fab_work_areas(id),
  FOREIGN KEY (company_id)      REFERENCES companies(id),
  UNIQUE KEY uq_fpwao_step_area (process_step_id, work_area_id),
  KEY idx_fpwao_step (process_step_id)
);

-- ── 5. Capacity import batch tracking ────────────────────────────────────────

CREATE TABLE IF NOT EXISTS fab_capacity_import_batches (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  company_id    INT          NOT NULL,
  file_name     VARCHAR(500) NOT NULL,
  uploaded_by   INT          NOT NULL,
  status        ENUM('Pending','Parsed','Failed','Imported') NOT NULL DEFAULT 'Pending',
  error_count   INT          DEFAULT 0,
  warning_count INT          DEFAULT 0,
  parsed_data   JSON         DEFAULT NULL,
  uploaded_at   TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (company_id)  REFERENCES companies(id),
  FOREIGN KEY (uploaded_by) REFERENCES users(id),
  KEY idx_fcib_company (company_id)
);
