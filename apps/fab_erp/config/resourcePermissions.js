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
  fabErpConstant:      'fab_erp_items_meta_manage',

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

  // Sales Orders
  fabErpSalesOrder:    'fab_erp_projects_manage',
  fabErpSoItem:        'fab_erp_projects_manage',

  // Supplier × Item
  fabErpSupplierItem:  'fab_erp_grn_manage',

  // Projects & items
  fabErpItem:            'fab_erp_projects_manage',
  fabErpItemMetricValue: 'fab_erp_projects_manage',

  // Material BOMs (catalog-level templates)
  fabErpMaterialBom:     'fab_erp_items_meta_manage',
  fabErpMaterialBomItem: 'fab_erp_items_meta_manage',
  fabErpItemConfigValue: 'fab_erp_items_meta_manage',

  // Calendars & shifts
  fabErpShiftCalendar: 'fab_erp_calendars_manage',
  fabErpShift:         'fab_erp_calendars_manage',
  fabErpCalendarDay:   'fab_erp_calendars_manage',

  // Planning
  fabErpPlannedOperation:  'fab_erp_planning_manage',
  fabErpResourceAssignment: 'fab_erp_planning_manage',

  // Inventory / GRN (item categorization, stock, batches, GRN)
  fabErpCustomField:   'fab_erp_taxonomy_manage',
  fabErpItemCategory:  'fab_erp_taxonomy_manage',
  fabErpItemGroup:     'fab_erp_taxonomy_manage',
  fabErpItemSubgroup:  'fab_erp_taxonomy_manage',
  fabErpStockLocation: 'fab_erp_stock_location_manage',
  fabErpSupplier:      'fab_erp_grn_manage',
  fabErpStockBalance:  'fab_erp_inventory_manage',
  fabErpStockPolicy:   'fab_erp_inventory_manage',
  fabErpItemBatch:     'fab_erp_inventory_manage',
  fabErpGrn:           'fab_erp_grn_manage',
  fabErpGrnLine:       'fab_erp_grn_manage',
  fabErpStockLedger:   'fab_erp_inventory_manage',
};

export default resourcePermissions;
