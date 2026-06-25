import { exportCapacity } from '../services/capacityExportService.js';
import { parseCapacityExcel, importCapacityBatch } from '../services/capacityImportService.js';
import { logger } from '../../../core/utils/logger.js';
import { pool } from '../../../db.js';

const companyId = (req) => req.user?.companyId ?? req.user?.company_id;

export const exportCapacityHandler = async (req, res) => {
  try {
    const buffer = await exportCapacity(companyId(req));
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="FabFlow_Capacity_Master.xlsx"');
    res.send(buffer);
  } catch (err) {
    logger.error({ err }, 'fab_flow: exportCapacity failed');
    res.status(500).json({ success: false, error: err.message });
  }
};

export const uploadCapacityHandler = async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, error: 'No file uploaded' });
    const result = await parseCapacityExcel(req.file, req.user.id, companyId(req));
    res.json({ success: true, data: result });
  } catch (err) {
    logger.error({ err }, 'fab_flow: parseCapacityExcel failed');
    res.status(400).json({ success: false, error: err.message });
  }
};

export const importCapacityBatchHandler = async (req, res) => {
  try {
    const result = await importCapacityBatch(Number(req.params.batchId), req.user.id, companyId(req));
    res.json({ success: true, data: result });
  } catch (err) {
    logger.error({ err }, 'fab_flow: importCapacityBatch failed');
    res.status(400).json({ success: false, error: err.message });
  }
};

// Replace all capabilities for a work area
export const syncWorkAreaCapsHandler = async (req, res) => {
  const cid   = companyId(req);
  const waId  = Number(req.params.waId);
  const caps  = req.body.caps ?? [];   // [{processType, priority}]
  const conn  = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query('DELETE FROM fab_work_area_capabilities WHERE work_area_id = ? AND company_id = ?', [waId, cid]);
    for (const c of caps) {
      await conn.query(
        'INSERT INTO fab_work_area_capabilities (work_area_id, company_id, process_type, allowed, priority) VALUES (?,?,?,1,?)',
        [waId, cid, c.processType, c.priority ?? 1],
      );
    }
    await conn.commit();
    res.json({ success: true });
  } catch (err) {
    await conn.rollback();
    logger.error({ err }, 'fab_flow: syncWorkAreaCaps failed');
    res.status(400).json({ success: false, error: err.message });
  } finally {
    conn.release();
  }
};

// Replace all capabilities for a machine
export const syncMachineCapsHandler = async (req, res) => {
  const cid      = companyId(req);
  const machineId = Number(req.params.machineId);
  const caps      = req.body.caps ?? [];  // [{processType, capacityHoursPerDay, priority}]
  const conn      = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query('DELETE FROM fab_machine_capabilities WHERE machine_id = ? AND company_id = ?', [machineId, cid]);
    for (const c of caps) {
      await conn.query(
        'INSERT INTO fab_machine_capabilities (machine_id, company_id, process_type, capacity_hours_per_day, priority) VALUES (?,?,?,?,?)',
        [machineId, cid, c.processType, c.capacityHoursPerDay ?? 8, c.priority ?? 1],
      );
    }
    await conn.commit();
    res.json({ success: true });
  } catch (err) {
    await conn.rollback();
    logger.error({ err }, 'fab_flow: syncMachineCaps failed');
    res.status(400).json({ success: false, error: err.message });
  } finally {
    conn.release();
  }
};

// Replace working days and exceptions for a calendar
export const syncCalendarSubHandler = async (req, res) => {
  const cid        = companyId(req);
  const calendarId = Number(req.params.calendarId);
  const days       = req.body.days       ?? [];  // [{dayOfWeek, isWorkingDay, startTime, endTime, workingHours}]
  const exceptions = req.body.exceptions ?? [];  // [{exceptionDate, exceptionName, isWorkingDay, workingHours, notes}]
  const conn       = await pool.getConnection();
  try {
    await conn.beginTransaction();
    // Upsert working days
    for (const d of days) {
      await conn.query(
        `INSERT INTO fab_work_calendar_days (calendar_id, company_id, day_of_week, is_working_day, start_time, end_time, working_hours)
         VALUES (?,?,?,?,?,?,?)
         ON DUPLICATE KEY UPDATE is_working_day=VALUES(is_working_day), start_time=VALUES(start_time), end_time=VALUES(end_time), working_hours=VALUES(working_hours)`,
        [calendarId, cid, d.dayOfWeek, d.isWorkingDay ? 1 : 0, d.startTime || null, d.endTime || null, d.workingHours ?? 0],
      );
    }
    // Replace exceptions
    await conn.query('DELETE FROM fab_work_calendar_exceptions WHERE calendar_id = ? AND company_id = ?', [calendarId, cid]);
    for (const e of exceptions) {
      if (!e.exceptionDate) continue;
      await conn.query(
        'INSERT INTO fab_work_calendar_exceptions (calendar_id, company_id, exception_date, exception_name, is_working_day, working_hours, notes) VALUES (?,?,?,?,?,?,?)',
        [calendarId, cid, e.exceptionDate, e.exceptionName || null, e.isWorkingDay ? 1 : 0, e.workingHours ?? 0, e.notes || null],
      );
    }
    await conn.commit();
    res.json({ success: true });
  } catch (err) {
    await conn.rollback();
    logger.error({ err }, 'fab_flow: syncCalendarSub failed');
    res.status(400).json({ success: false, error: err.message });
  } finally {
    conn.release();
  }
};
