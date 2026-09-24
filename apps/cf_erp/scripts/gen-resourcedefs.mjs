// Generates cf_erp's resourceDef JSON files (core + the codegen and parties
// modules) from one compact spec, so every field has a type, every relation
// alias matches its fields, and every resource maps companyId to
// <alias>.company_id — the query engine only scopes a read to the tenant when it
// sees that mapping.
//
// Edit the spec below, never the JSON, then run:  node apps/cf_erp/scripts/gen-resourcedefs.mjs
// (from multi_app_be/). It overwrites the three resourceDef.json files.
//
// Writes do NOT go through these resources for anything with a rule behind it
// (items, definitions, values, BOMs, orders) — `write` lists are documentation.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));

const AUDIT = { createdAt: ['created_at', 'datetime'], updatedAt: ['updated_at', 'datetime'], createdBy: ['created_by', 'integer'] };

function camel(col) { return col.replace(/_([a-z])/g, (_, c) => c.toUpperCase()); }

// cols: [column, type] (camelCase key derived) ; write: columns the future cf_erp write layer may accept
function resource({ table, alias, cols, write = [], audit = AUDIT, relations = {} }) {
  const fields = { id: `${alias}.id`, companyId: `${alias}.company_id` };
  const fieldTypes = { id: 'integer', companyId: 'integer' };
  for (const [col, type] of cols) { const k = camel(col); fields[k] = `${alias}.${col}`; fieldTypes[k] = type; }
  for (const [k, [col, type]] of Object.entries(audit)) { fields[k] = `${alias}.${col}`; fieldTypes[k] = type; }
  const rels = {};
  for (const [name, r] of Object.entries(relations)) {
    const keys = [];
    for (const [key, col, type] of r.fields) { fields[key] = `${r.alias}.${col}`; fieldTypes[key] = type; keys.push(key); }
    rels[name] = { table: r.table, alias: r.alias, on: r.on, fields: keys };
  }
  return { table, alias, writeFields: write, fields, fieldTypes, relations: rels };
}

// detail tables are keyed by master_id, not id
function detailFix(def, alias) {
  def.fields.id = `${alias}.master_id`;
  return def;
}

const core = {
  // Service-only writes, like machines. A node's depth has to be its parent's
  // plus one, scope 'machine' belongs to a whole Family, and three separate
  // doors (Setup, the catalog, the Machines screen) each narrow what they may
  // make — none of which a generic INSERT knows about.
  cfErpClassificationNode: resource({
    table: 'cf_classification_nodes', alias: 'ccn',
    cols: [['parent_id', 'integer'], ['depth', 'integer'], ['scope', 'string'], ['code', 'string'], ['name', 'string'],
           ['description', 'text'], ['sort_order', 'integer'], ['status', 'string']],
    write: [],
    relations: { parent: { table: 'cf_classification_nodes', alias: 'ccn_p', on: 'ccn.parent_id = ccn_p.id',
      fields: [['parentCode', 'code', 'string'], ['parentName', 'name', 'string'], ['parentDepth', 'depth', 'integer']] } },
  }),

  // The one read resource for items AND definitions. Every relation hangs off
  // cmr directly, so no join depends on another (the query builder joins in
  // requested-field order and an ON can only see tables joined before it).
  // Writes do NOT go through the generic path: an item/definition is two rows.
  cfErpMasterRecord: resource({
    table: 'cf_master_records', alias: 'cmr',
    cols: [['record_kind', 'string'], ['code', 'string'], ['name', 'string'], ['short_name', 'string'], ['description', 'text'],
           ['classification_id', 'integer'], ['status', 'string'], ['revision', 'string'], ['default_flow_id', 'integer']],
    write: [],
    relations: {
      classification: { table: 'cf_classification_nodes', alias: 'ccn_m', on: 'cmr.classification_id = ccn_m.id',
        fields: [['classificationCode', 'code', 'string'], ['classificationName', 'name', 'string'], ['classificationDepth', 'depth', 'integer']] },
      itemDetail: { table: 'cf_item_details', alias: 'cid_m', on: 'cid_m.master_id = cmr.id',
        fields: [['itemType', 'item_type', 'string'], ['trackedBy', 'tracked_by', 'string'], ['uom', 'uom', 'string'],
                 ['sourcing', 'sourcing', 'string'],
                 ['sourceDefinitionId', 'source_definition_id', 'integer'], ['ownerOrderLineId', 'owner_order_line_id', 'integer']] },
      definitionDetail: { table: 'cf_definition_details', alias: 'cdd_m', on: 'cdd_m.master_id = cmr.id',
        fields: [['definitionType', 'definition_type', 'string'], ['selectionMode', 'selection_mode', 'string'],
                 ['candidateClassificationId', 'candidate_classification_id', 'integer']] },
    },
  }),

  cfErpSpecification: resource({
    table: 'cf_specifications', alias: 'csp',
    cols: [['code', 'string'], ['name', 'string'], ['data_type', 'string'], ['measurement_type', 'string'],
           ['default_uom', 'string'], ['decimals', 'integer'], ['description', 'text'], ['status', 'string']],
    write: ['code', 'name', 'data_type', 'measurement_type', 'default_uom', 'decimals', 'description', 'status'],
  }),

  cfErpSpecOption: resource({
    table: 'cf_spec_options', alias: 'cso',
    cols: [['specification_id', 'integer'], ['value', 'string'], ['label', 'string'], ['sort_order', 'integer'], ['status', 'string']],
    write: ['specification_id', 'value', 'label', 'sort_order', 'status'],
    relations: { specification: { table: 'cf_specifications', alias: 'csp_o', on: 'cso.specification_id = csp_o.id',
      fields: [['specCode', 'code', 'string'], ['specName', 'name', 'string']] } },
  }),

  cfErpFormula: resource({
    table: 'cf_formulas', alias: 'cfm',
    cols: [['code', 'string'], ['name', 'string'], ['expression', 'text'], ['version', 'integer'], ['description', 'text'], ['status', 'string']],
    write: ['code', 'name', 'expression', 'version', 'description', 'status'],
  }),

  cfErpSpecAssignment: resource({
    table: 'cf_spec_assignments', alias: 'csa',
    cols: [['specification_id', 'integer'], ['subject_type', 'string'], ['subject_id', 'integer'], ['capture_at', 'string'],
           ['is_required', 'boolean'], ['is_applicable', 'boolean'], ['value_rule', 'string'], ['formula_id', 'integer'], ['sort_order', 'integer']],
    write: ['specification_id', 'subject_type', 'subject_id', 'capture_at', 'is_required', 'is_applicable', 'value_rule', 'formula_id', 'sort_order'],
    relations: {
      specification: { table: 'cf_specifications', alias: 'csp_a', on: 'csa.specification_id = csp_a.id',
        fields: [['specCode', 'code', 'string'], ['specName', 'name', 'string'], ['specDataType', 'data_type', 'string'], ['specDefaultUom', 'default_uom', 'string']] },
      formula: { table: 'cf_formulas', alias: 'cfm_a', on: 'csa.formula_id = cfm_a.id',
        fields: [['formulaCode', 'code', 'string'], ['formulaName', 'name', 'string']] },
    },
  }),

  cfErpSpecAssignmentOption: resource({
    table: 'cf_spec_assignment_options', alias: 'csao',
    cols: [['assignment_id', 'integer'], ['option_id', 'integer']],
    write: ['assignment_id', 'option_id'],
    relations: { option: { table: 'cf_spec_options', alias: 'cso_ao', on: 'csao.option_id = cso_ao.id',
      fields: [['optionValue', 'value', 'string'], ['optionLabel', 'label', 'string']] } },
  }),

  // Service-only writes: every value change must also write history in the same
  // transaction (TiDB has no triggers).
  cfErpSpecValue: resource({
    table: 'cf_spec_values', alias: 'csv',
    cols: [['specification_id', 'integer'], ['subject_type', 'string'], ['subject_id', 'integer'], ['value_number', 'decimal'],
           ['value_text', 'string'], ['value_bool', 'boolean'], ['value_date', 'date'], ['option_id', 'integer'], ['uom', 'string'], ['source', 'string']],
    write: [],
    relations: {
      specification: { table: 'cf_specifications', alias: 'csp_v', on: 'csv.specification_id = csp_v.id',
        fields: [['specCode', 'code', 'string'], ['specName', 'name', 'string'], ['specDataType', 'data_type', 'string']] },
      option: { table: 'cf_spec_options', alias: 'cso_v', on: 'csv.option_id = cso_v.id',
        fields: [['optionValue', 'value', 'string'], ['optionLabel', 'label', 'string']] },
    },
  }),

  // Append-only, written by the value service.
  cfErpSpecValueHistory: resource({
    table: 'cf_spec_value_history', alias: 'csvh',
    cols: [['value_id', 'integer'], ['specification_id', 'integer'], ['subject_type', 'string'], ['subject_id', 'integer'],
           ['change_type', 'string'], ['old_value', 'json'], ['new_value', 'json'], ['changed_by', 'integer'], ['changed_at', 'datetime']],
    write: [], audit: {},
    relations: { specification: { table: 'cf_specifications', alias: 'csp_h', on: 'csvh.specification_id = csp_h.id',
      fields: [['specCode', 'code', 'string'], ['specName', 'name', 'string']] } },
  }),

  cfErpDefinitionAllowedItem: resource({
    table: 'cf_definition_allowed_items', alias: 'cdai',
    cols: [['definition_id', 'integer'], ['item_id', 'integer'], ['is_default', 'boolean'], ['sort_order', 'integer']],
    write: ['definition_id', 'item_id', 'is_default', 'sort_order'],
    relations: {
      definition: { table: 'cf_master_records', alias: 'cmr_d', on: 'cdai.definition_id = cmr_d.id',
        fields: [['definitionCode', 'code', 'string'], ['definitionName', 'name', 'string']] },
      item: { table: 'cf_master_records', alias: 'cmr_i', on: 'cdai.item_id = cmr_i.id',
        fields: [['itemCode', 'code', 'string'], ['itemName', 'name', 'string']] },
    },
  }),

  cfErpSelectionCriterion: resource({
    table: 'cf_selection_criteria', alias: 'csc',
    cols: [['definition_id', 'integer'], ['specification_id', 'integer'], ['operator', 'string'], ['value_number', 'decimal'],
           ['value_number_to', 'decimal'], ['value_text', 'string'], ['value_bool', 'boolean'], ['value_date', 'date'],
           ['option_id', 'integer'], ['sort_order', 'integer']],
    write: ['definition_id', 'specification_id', 'operator', 'value_number', 'value_number_to', 'value_text', 'value_bool', 'value_date', 'option_id', 'sort_order'],
    relations: {
      specification: { table: 'cf_specifications', alias: 'csp_c', on: 'csc.specification_id = csp_c.id',
        fields: [['specCode', 'code', 'string'], ['specName', 'name', 'string']] },
      option: { table: 'cf_spec_options', alias: 'cso_c', on: 'csc.option_id = cso_c.id',
        fields: [['optionValue', 'value', 'string']] },
    },
  }),

  // BOMs — service-only writes: a line can create temporary items, and every
  // change re-works roll-ups and inherited values.
  cfErpBom: resource({
    table: 'cf_boms', alias: 'cbm',
    cols: [['parent_id', 'integer'], ['bom_type', 'string'], ['revision', 'string'], ['status', 'string'],
           ['source_bom_id', 'integer'], ['notes', 'text']],
    relations: {
      parent: { table: 'cf_master_records', alias: 'cmr_b', on: 'cbm.parent_id = cmr_b.id',
        fields: [['parentCode', 'code', 'string'], ['parentName', 'name', 'string'], ['parentStatus', 'status', 'string']] },
    },
  }),
  cfErpBomLine: resource({
    table: 'cf_bom_lines', alias: 'cbl',
    cols: [['bom_id', 'integer'], ['line_no', 'integer'], ['child_id', 'integer'], ['design_id', 'integer'], ['position', 'integer'],
           ['role', 'string'], ['quantity', 'decimal'], ['selection_definition_id', 'integer'], ['source_line_id', 'integer'],
           ['operation_flow_id', 'integer'], ['notes', 'text']],
    relations: {
      bom: { table: 'cf_boms', alias: 'cbm_l', on: 'cbl.bom_id = cbm_l.id',
        fields: [['bomParentId', 'parent_id', 'integer'], ['bomType', 'bom_type', 'string']] },
      child: { table: 'cf_master_records', alias: 'cmr_c', on: 'cbl.child_id = cmr_c.id',
        fields: [['childCode', 'code', 'string'], ['childName', 'name', 'string'], ['childRecordKind', 'record_kind', 'string'], ['childStatus', 'status', 'string']] },
      selection: { table: 'cf_master_records', alias: 'cmr_s', on: 'cbl.selection_definition_id = cmr_s.id',
        fields: [['selectionCode', 'code', 'string'], ['selectionName', 'name', 'string']] },
    },
  }),

  // Sales orders — service-only writes: a custom line creates its whole structure.
  cfErpSalesOrder: resource({
    table: 'cf_sales_orders', alias: 'csor',
    cols: [['code', 'string'], ['order_type', 'string'], ['title', 'string'], ['customer_id', 'integer'], ['customer_reference', 'string'],
           ['status', 'string'], ['received_on', 'date'], ['committed_date', 'date'], ['confirmed_at', 'datetime'],
           ['delivery_address', 'text'], ['notes', 'text']],
    relations: {
      customer: { table: 'cf_parties', alias: 'cpt_o', on: 'csor.customer_id = cpt_o.id',
        fields: [['customerCode', 'code', 'string'], ['customerName', 'name', 'string']] },
    },
  }),
  cfErpSalesOrderLine: resource({
    table: 'cf_sales_order_lines', alias: 'csol',
    cols: [['order_id', 'integer'], ['line_no', 'integer'], ['line_type', 'string'], ['item_id', 'integer'], ['design_id', 'integer'],
           ['position', 'integer'], ['quantity', 'decimal'], ['committed_date', 'date'], ['bom_revision', 'string'],
           ['description', 'string'], ['notes', 'text']],
    relations: {
      order: { table: 'cf_sales_orders', alias: 'csor_l', on: 'csol.order_id = csor_l.id',
        fields: [['orderCode', 'code', 'string'], ['orderStatus', 'status', 'string']] },
      item: { table: 'cf_master_records', alias: 'cmr_ol', on: 'csol.item_id = cmr_ol.id',
        fields: [['itemCode', 'code', 'string'], ['itemName', 'name', 'string']] },
    },
  }),

  // Production masters — service-only writes: machines carry specification
  // values, flows are checked step against wait rule.
  cfErpMachine: resource({
    table: 'cf_machines', alias: 'cmc',
    cols: [['code', 'string'], ['name', 'string'], ['classification_id', 'integer'], ['catalog_item_id', 'integer'],
           ['serial_number', 'string'], ['status', 'string'], ['notes', 'text']],
    relations: {
      machineType: { table: 'cf_classification_nodes', alias: 'ccn_mc', on: 'cmc.classification_id = ccn_mc.id',
        fields: [['machineTypeCode', 'code', 'string'], ['machineTypeName', 'name', 'string']] },
    },
  }),
  cfErpOperation: resource({
    table: 'cf_operations', alias: 'cop',
    cols: [['code', 'string'], ['name', 'string'], ['description', 'text'], ['status', 'string']],
  }),
  cfErpOperationFlow: resource({
    table: 'cf_operation_flows', alias: 'cof',
    cols: [['code', 'string'], ['name', 'string'], ['description', 'text'], ['revision', 'string'], ['status', 'string']],
  }),
  cfErpOperationFlowStep: resource({
    table: 'cf_operation_flow_steps', alias: 'cofs',
    cols: [['flow_id', 'integer'], ['sequence', 'integer'], ['operation_id', 'integer'], ['step_name', 'string'], ['notes', 'text']],
    relations: {
      operation: { table: 'cf_operations', alias: 'cop_s', on: 'cofs.operation_id = cop_s.id',
        fields: [['operationCode', 'code', 'string'], ['operationName', 'name', 'string']] },
      flow: { table: 'cf_operation_flows', alias: 'cof_s', on: 'cofs.flow_id = cof_s.id',
        fields: [['flowCode', 'code', 'string'], ['flowStatus', 'status', 'string']] },
    },
  }),
  cfErpStepWaitRule: resource({
    table: 'cf_step_wait_rules', alias: 'cswr',
    cols: [['flow_step_id', 'integer'], ['relation', 'string'], ['target_definition_id', 'integer'], ['target_operation_id', 'integer'],
           ['required_status', 'string'], ['notes', 'text']],
    relations: {
      targetOperation: { table: 'cf_operations', alias: 'cop_w', on: 'cswr.target_operation_id = cop_w.id',
        fields: [['targetOperationCode', 'code', 'string']] },
      targetDefinition: { table: 'cf_master_records', alias: 'cmr_w', on: 'cswr.target_definition_id = cmr_w.id',
        fields: [['targetDefinitionCode', 'code', 'string']] },
    },
  }),
  cfErpMachineShift: resource({
    table: 'cf_machine_shifts', alias: 'cms',
    cols: [['machine_id', 'integer'], ['name', 'string'], ['weekdays', 'string'], ['start_time', 'string'], ['end_time', 'string'],
           ['break_minutes', 'integer'], ['effective_from', 'date'], ['effective_to', 'date'], ['sort_order', 'integer'], ['notes', 'text']],
    relations: {
      machine: { table: 'cf_machines', alias: 'cmc_s', on: 'cms.machine_id = cmc_s.id', fields: [['machineCode', 'code', 'string']] },
    },
  }),
  cfErpMachineCalendarException: resource({
    table: 'cf_machine_calendar_exceptions', alias: 'cmce',
    cols: [['machine_id', 'integer'], ['exception_date', 'date'], ['kind', 'string'], ['shift_id', 'integer'],
           ['start_time', 'string'], ['end_time', 'string'], ['reason', 'string']],
  }),

  // Inventory — service-only writes: stock moves only through movements, which
  // write ledger rows and balances together.
  cfErpStockingArea: resource({
    table: 'cf_stocking_areas', alias: 'csar',
    cols: [['code', 'string'], ['name', 'string'], ['purpose', 'string'], ['machine_id', 'integer'], ['status', 'string'], ['notes', 'text']],
  }),
  cfErpStockBatch: resource({
    table: 'cf_stock_batches', alias: 'csb',
    cols: [['item_id', 'integer'], ['code', 'string'], ['status', 'string'], ['status_note', 'string'], ['received_on', 'date'],
           ['supplier_id', 'integer'], ['supplier_ref', 'string'], ['notes', 'text']],
    relations: {
      item: { table: 'cf_master_records', alias: 'cmr_sb', on: 'csb.item_id = cmr_sb.id', fields: [['itemCode', 'code', 'string'], ['itemName', 'name', 'string']] },
    },
  }),
  cfErpStockMovement: resource({
    table: 'cf_stock_movements', alias: 'csm',
    cols: [['code', 'string'], ['movement_type', 'string'], ['movement_date', 'date'], ['party_id', 'integer'], ['order_id', 'integer'],
           ['reference', 'string'], ['reason', 'string'], ['reversal_of_id', 'integer'], ['reversed_by_id', 'integer'], ['notes', 'text']],
  }),
  cfErpStockLedger: resource({
    table: 'cf_stock_ledger', alias: 'csl',
    cols: [['movement_id', 'integer'], ['line_no', 'integer'], ['stocking_area_id', 'integer'], ['item_id', 'integer'], ['batch_id', 'integer'],
           ['quantity', 'decimal'], ['notes', 'string']],
    relations: {
      movement: { table: 'cf_stock_movements', alias: 'csm_l', on: 'csl.movement_id = csm_l.id',
        fields: [['movementCode', 'code', 'string'], ['movementType', 'movement_type', 'string'], ['movementDate', 'movement_date', 'date']] },
    },
  }),
  cfErpStockBalance: resource({
    table: 'cf_stock_balances', alias: 'csk',
    cols: [['stocking_area_id', 'integer'], ['item_id', 'integer'], ['batch_id', 'integer'], ['quantity', 'decimal'], ['last_movement_id', 'integer']],
    audit: { createdAt: ['created_at', 'datetime'], updatedAt: ['updated_at', 'datetime'] },
    relations: {
      area: { table: 'cf_stocking_areas', alias: 'csar_k', on: 'csk.stocking_area_id = csar_k.id', fields: [['areaCode', 'code', 'string'], ['areaPurpose', 'purpose', 'string']] },
      item: { table: 'cf_master_records', alias: 'cmr_k', on: 'csk.item_id = cmr_k.id', fields: [['itemCode', 'code', 'string'], ['itemName', 'name', 'string']] },
      batch: { table: 'cf_stock_batches', alias: 'csb_k', on: 'csk.batch_id = csb_k.id', fields: [['batchCode', 'code', 'string'], ['batchStatus', 'status', 'string']] },
    },
  }),
  cfErpOperationMachineRule: resource({
    table: 'cf_operation_machine_rules', alias: 'comr',
    cols: [['operation_id', 'integer'], ['subject_type', 'string'], ['subject_id', 'integer'], ['eligible', 'boolean'],
           ['setup_minutes', 'decimal'], ['setup_formula_id', 'integer'], ['work_minutes', 'decimal'], ['work_formula_id', 'integer'],
           ['effective_from', 'date'], ['effective_to', 'date'], ['notes', 'text']],
    relations: {
      operation: { table: 'cf_operations', alias: 'cop_r', on: 'comr.operation_id = cop_r.id',
        fields: [['operationCode', 'code', 'string']] },
    },
  }),
  // Release and the production tracker (§13): read-only here — release writes
  // them whole and the shop floor changes steps only through the service.
  cfErpProductionRelease: resource({
    table: 'cf_production_releases', alias: 'cprl',
    cols: [['order_id', 'integer'], ['order_line_id', 'integer'], ['item_id', 'integer'], ['item_revision', 'string'], ['quantity', 'decimal'], ['notes', 'text']],
    relations: {
      order: { table: 'cf_sales_orders', alias: 'csor_rl', on: 'cprl.order_id = csor_rl.id', fields: [['orderCode', 'code', 'string'], ['orderStatus', 'status', 'string']] },
    },
  }),
  cfErpProductionItem: resource({
    table: 'cf_production_items', alias: 'cpri',
    cols: [['release_id', 'integer'], ['parent_id', 'integer'], ['item_id', 'integer'], ['bom_line_id', 'integer'], ['piece_no', 'integer'],
           ['quantity', 'decimal'], ['code', 'string'], ['flow_id', 'integer'], ['flow_revision', 'string'], ['depth', 'integer'], ['sort_order', 'integer']],
    relations: {
      item: { table: 'cf_master_records', alias: 'cmr_pi', on: 'cpri.item_id = cmr_pi.id', fields: [['itemCode', 'code', 'string'], ['itemName', 'name', 'string']] },
    },
  }),
  cfErpProductionStep: resource({
    table: 'cf_production_steps', alias: 'cprs',
    cols: [['production_item_id', 'integer'], ['flow_step_id', 'integer'], ['operation_id', 'integer'], ['sequence', 'integer'], ['step_name', 'string'],
           ['quantity', 'decimal'], ['state', 'string'], ['held_from', 'string'], ['qty_good', 'decimal'], ['qty_scrap', 'decimal'],
           ['machine_id', 'integer'], ['started_at', 'datetime'], ['finished_at', 'datetime']],
    relations: {
      operation: { table: 'cf_operations', alias: 'cop_ps', on: 'cprs.operation_id = cop_ps.id', fields: [['operationCode', 'code', 'string'], ['operationName', 'name', 'string']] },
    },
  }),
  cfErpStepDependency: resource({
    table: 'cf_step_dependencies', alias: 'csdp',
    cols: [['step_id', 'integer'], ['target_step_id', 'integer'], ['target_item_id', 'integer'], ['required', 'string'], ['origin', 'string'], ['wait_rule_id', 'integer']],
  }),
  cfErpMaterialRequirement: resource({
    table: 'cf_material_requirements', alias: 'cmrq',
    cols: [['release_id', 'integer'], ['production_item_id', 'integer'], ['step_id', 'integer'], ['item_id', 'integer'], ['bom_line_id', 'integer'],
           ['quantity', 'decimal'], ['issued', 'decimal']],
    relations: {
      item: { table: 'cf_master_records', alias: 'cmr_rq', on: 'cmrq.item_id = cmr_rq.id', fields: [['itemCode', 'code', 'string'], ['itemName', 'name', 'string']] },
    },
  }),
  cfErpStockReservation: resource({
    table: 'cf_stock_reservations', alias: 'csrv',
    cols: [['requirement_id', 'integer'], ['item_id', 'integer'], ['batch_id', 'integer'], ['quantity', 'decimal'], ['status', 'string'], ['closed_at', 'datetime']],
    relations: {
      item: { table: 'cf_master_records', alias: 'cmr_rv', on: 'csrv.item_id = cmr_rv.id', fields: [['itemCode', 'code', 'string']] },
      batch: { table: 'cf_stock_batches', alias: 'csb_rv', on: 'csrv.batch_id = csb_rv.id', fields: [['batchCode', 'code', 'string']] },
    },
  }),
  cfErpStepEvent: resource({
    table: 'cf_step_events', alias: 'csev',
    cols: [['step_id', 'integer'], ['event', 'string'], ['qty_good', 'decimal'], ['qty_scrap', 'decimal'], ['machine_id', 'integer'], ['note', 'string']],
  }),
  cfErpPurchaseOrder: resource({
    table: 'cf_purchase_orders', alias: 'cpo',
    cols: [['code', 'string'], ['supplier_id', 'integer'], ['status', 'string'], ['suggested', 'integer'],
           ['expected_date', 'date'], ['ordered_at', 'datetime'], ['notes', 'text']],
    relations: {
      supplier: { table: 'cf_parties', alias: 'cpt_po', on: 'cpo.supplier_id = cpt_po.id', fields: [['supplierCode', 'code', 'string'], ['supplierName', 'name', 'string']] },
    },
  }),
  cfErpPurchaseOrderLine: resource({
    table: 'cf_purchase_order_lines', alias: 'cpol',
    cols: [['purchase_order_id', 'integer'], ['line_no', 'integer'], ['item_id', 'integer'], ['quantity', 'decimal'],
           ['qty_received', 'decimal'], ['uom', 'string'], ['expected_date', 'date'], ['note', 'string']],
    relations: {
      order: { table: 'cf_purchase_orders', alias: 'cpo_l', on: 'cpol.purchase_order_id = cpo_l.id', fields: [['orderCode', 'code', 'string'], ['orderStatus', 'status', 'string']] },
      item: { table: 'cf_master_records', alias: 'cmr_pl', on: 'cpol.item_id = cmr_pl.id', fields: [['itemCode', 'code', 'string'], ['itemName', 'name', 'string']] },
    },
  }),

  // Drawings are read-only through the generic path. A revision is a NEW ROW
  // whose links are copied from the one it supersedes, so a generic UPDATE of
  // `revision` or `status` would silently rewrite what a piece was built to —
  // exactly the history these rows exist to hold. routes/drawings.js only.
  cfErpDrawing: resource({
    table: 'cf_drawings', alias: 'cdw',
    cols: [['code', 'string'], ['number', 'string'], ['revision', 'string'], ['title', 'string'], ['source', 'string'],
           ['url', 'string'], ['status', 'string'], ['issued_on', 'date'], ['notes', 'text'],
           ['root_id', 'integer'], ['supersedes_id', 'integer']],
    write: [],
    relations: {
      root: { table: 'cf_drawings', alias: 'cdw_r', on: 'cdw.root_id = cdw_r.id',
        fields: [['rootCode', 'code', 'string'], ['rootRevision', 'revision', 'string']] },
    },
  }),
  cfErpDrawingLink: resource({
    table: 'cf_drawing_links', alias: 'cdl',
    cols: [['drawing_id', 'integer'], ['subject_type', 'string'], ['subject_id', 'integer'], ['note', 'string']],
    write: [],
    relations: {
      drawing: { table: 'cf_drawings', alias: 'cdw_l', on: 'cdl.drawing_id = cdw_l.id',
        fields: [['drawingCode', 'code', 'string'], ['drawingNumber', 'number', 'string'],
                 ['drawingRevision', 'revision', 'string'], ['drawingStatus', 'status', 'string'],
                 ['drawingSource', 'source', 'string'], ['drawingTitle', 'title', 'string']] },
      // Only subject_type 'master_record' exists, so the join is unambiguous today.
      record: { table: 'cf_master_records', alias: 'cmr_dl', on: 'cdl.subject_id = cmr_dl.id',
        fields: [['recordCode', 'code', 'string'], ['recordName', 'name', 'string'], ['recordStatus', 'status', 'string']] },
    },
  }),
};

// The parties module — people edit parties through its own routes (roles are
// validated there), so the generic write path lists nothing either.
const parties = {
  cfErpParty: resource({
    table: 'cf_parties', alias: 'cpt',
    cols: [['code', 'string'], ['name', 'string'], ['is_customer', 'boolean'], ['is_supplier', 'boolean'], ['is_subcontractor', 'boolean'],
           ['tax_number', 'string'], ['contact_name', 'string'], ['email', 'string'], ['phone', 'string'], ['address', 'text'],
           ['notes', 'text'], ['status', 'string']],
  }),
};

const codegen = {
  cfErpCodeScheme: resource({
    table: 'cf_code_schemes', alias: 'ccs',
    cols: [['code', 'string'], ['name', 'string'], ['entity_type', 'string'], ['target_field', 'string'], ['seq_scope', 'string'],
           ['priority', 'integer'], ['description', 'text'], ['status', 'string']],
    write: ['code', 'name', 'entity_type', 'target_field', 'seq_scope', 'priority', 'description', 'status'],
  }),
  cfErpCodeSchemeCondition: resource({
    table: 'cf_code_scheme_conditions', alias: 'ccsc',
    cols: [['scheme_id', 'integer'], ['token_key', 'string'], ['operator', 'string'], ['value', 'string']],
    write: ['scheme_id', 'token_key', 'operator', 'value'],
  }),
  cfErpCodeSchemeSegment: resource({
    table: 'cf_code_scheme_segments', alias: 'ccss',
    cols: [['scheme_id', 'integer'], ['sort_order', 'integer'], ['segment_type', 'string'], ['literal_text', 'string'],
           ['token_key', 'string'], ['format', 'string'], ['transform', 'string'], ['max_length', 'integer'], ['is_required', 'boolean']],
    write: ['scheme_id', 'sort_order', 'segment_type', 'literal_text', 'token_key', 'format', 'transform', 'max_length', 'is_required'],
  }),
  // Counters: read-only to everything but the generator.
  cfErpCodeSequence: resource({
    table: 'cf_code_sequences', alias: 'ccq',
    cols: [['scheme_id', 'integer'], ['seq_key', 'string'], ['next_value', 'integer']],
    write: [], audit: { createdAt: ['created_at', 'datetime'], updatedAt: ['updated_at', 'datetime'] },
  }),
};

const outputs = [
  ['core', path.join(here, '..', 'resourceDef.json'), core],
  ['codegen', path.join(here, '..', 'modules', 'codegen', 'resourceDef.json'), codegen],
  ['parties', path.join(here, '..', 'modules', 'parties', 'resourceDef.json'), parties],
];
for (const [name, file, defs] of outputs) {
  fs.writeFileSync(file, JSON.stringify(defs, null, 2) + '\n');
  console.log(`${name.padEnd(8)} ${Object.keys(defs).length} resources: ${Object.keys(defs).join(', ')}`);
}
