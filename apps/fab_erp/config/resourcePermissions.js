// Maps each fab_erp resource alias to the required uiPermissions feature_tag
// that a non-admin user must hold to perform any write (insert / update / delete).

const resourcePermissions = {
  // Infrastructure / master data
  fabErpPlant:                 'fab_erp_resources_manage',
  fabErpResourceType:          'fab_erp_resources_manage',
  fabErpResourceTypeMetric:    'fab_erp_resources_manage',
  fabErpResourceTypeProperty:  'fab_erp_resource_type_properties_manage',
  fabErpResource:              'fab_erp_resources_manage',

  // Process master catalogue
  fabErpProcessMaster: 'fab_erp_process_master_manage',

  // Parts catalog (shared across projects)
  fabErpItemCatalog: 'fab_erp_items_meta_manage',

  // Item meta
  fabErpItemMetricDef: 'fab_erp_items_meta_manage',

  // Formulas
  fabErpFormulaSet: 'fab_erp_formulas_manage',
  fabErpFormula:    'fab_erp_formulas_manage',

  // Templates
  fabErpProcessTemplate:      'fab_erp_templates_manage',
  fabErpProcessTemplateStep:  'fab_erp_templates_manage',
  fabErpRoutingTemplate:      'fab_erp_templates_manage',
  fabErpRoutingTemplateStep:  'fab_erp_templates_manage',
  fabErpMfgMethodTemplate:    'fab_erp_templates_manage',
  fabErpMfgMethodLine:        'fab_erp_templates_manage',

  // Progress report templates (Project Progress view config)
  fabErpProgressTemplate:  'fab_erp_taskengine_view',
  fabErpProgressStage:     'fab_erp_taskengine_view',
  fabErpProgressStageOp:   'fab_erp_taskengine_view',

  // Orders (sales, manufacturing, purchase, planned, subcontract, transfer)
  fabErpOrder:     'fab_erp_projects_manage',
  fabErpOrderLine: 'fab_erp_projects_manage',

  // Supplier × Item

  // Projects & items
  fabErpItem:            'fab_erp_projects_manage',
  fabErpItemMetricValue: 'fab_erp_projects_manage',

  // Material BOMs (catalog-level templates)
  fabErpMaterialBom:     'fab_erp_items_meta_manage',
  fabErpMaterialBomItem: 'fab_erp_items_meta_manage',

  // Calendars & shifts
  fabErpShiftCalendar: 'fab_erp_calendars_manage',
  fabErpShift:         'fab_erp_calendars_manage',
  fabErpCalendarDay:   'fab_erp_calendars_manage',

  // Operations
  fabErpOperation:             'fab_erp_operations_manage',
  fabErpOperationVariable:     'fab_erp_operations_manage',
  fabErpOperationResourceType: 'fab_erp_operations_manage',

  // Flows
  fabErpOperationFlow:      'fab_erp_flows_manage',
  fabErpOperationFlowStep:  'fab_erp_flows_manage',
  // Which flow a level/variant gets by default — same authority as editing the
  // flows themselves, since a rule decides what actually gets made.
  fabErpFlowRule:           'fab_erp_flows_manage',

  // Project Task Queue
  fabErpProjectTask: 'fab_erp_taskqueue_manage',

  // BOM ↔ Flow attach
  fabErpBomFlowBinding: 'fab_erp_flows_manage',

  // BOM Templates

  // Inventory / GRN (item categorization, stock, batches, GRN)
  fabErpCustomField:   'fab_erp_taxonomy_manage',
  fabErpItemCategory:  'fab_erp_taxonomy_manage',
  fabErpMarkScheme:    'fab_erp_taxonomy_manage',
  fabErpItemGroup:     'fab_erp_taxonomy_manage',
  fabErpItemSubgroup:  'fab_erp_taxonomy_manage',
  fabErpStockLocation: 'fab_erp_stock_location_manage',
  fabErpCustomer:      'fab_erp_projects_manage',
  fabErpCodegenRule:   'fab_erp_items_meta_manage',
  fabErpStockPolicy:   'fab_erp_inventory_manage',
  fabErpStockPiece:    'fab_erp_inventory_manage',
  fabErpStockLedger:   'fab_erp_inventory_manage',
};

export default resourcePermissions;
