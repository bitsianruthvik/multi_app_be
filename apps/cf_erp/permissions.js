/**
 * permissions.js — CF ERP's permissions as an admin reads them (company admin panel, core/admin; user 2026-11-19).
 *
 * The code checks 31 tags (lib/http.js PERM, approvalService). An admin does not think in tags: they think "Stores may
 * manage stock and see orders". This file is that translation, and the ONE place it lives:
 *
 *   departments   an area of the app with levels, lowest first. A level is the exact set of tags it gives; a role is
 *                 AT a level when it holds exactly that level's tags of the department (anything else shows as Custom).
 *   approvals     each a separate yes / no.
 *   switches      a named bundle that is on or off.
 *   standardRoles the roles the app ships with: a company starts from these, changes them, or copies them.
 *
 * A NEW TAG goes here in the same change that adds it to the code — into a level, an approval or a switch — and into
 * the standard roles that should have it. A tag missing here still works; the panel lists it under "Other permissions".
 */
const t = (...names) => names.map((n) => `cf_erp_${n}`);

export const departments = [
  { key: 'sales', label: 'Sales orders', help: 'Orders, their structures, values and nesting.', levels: [
    { key: 'view', label: 'View', tags: t('orders_view') },
    { key: 'manage', label: 'Manage', tags: t('orders_view', 'orders_manage') },
  ] },
  { key: 'parties', label: 'Customers and suppliers', help: 'Add and change customers, suppliers and contractors.', levels: [
    { key: 'manage', label: 'Manage', tags: t('parties_manage') },
  ] },
  { key: 'catalog', label: 'Catalog', help: 'Items, definitions, specifications, formulas and coding rules.', levels: [
    { key: 'view', label: 'View', tags: t('catalog_view') },
    { key: 'manage', label: 'Manage items', tags: t('catalog_view', 'catalog_manage') },
    { key: 'setup', label: 'Manage and set up', tags: t('catalog_view', 'catalog_manage', 'setup_manage', 'codegen_manage') },
  ] },
  { key: 'stores', label: 'Stores', help: 'Stock, requests, receiving, audits and things given out.', levels: [
    { key: 'view', label: 'View stock', tags: t('inventory_view') },
    { key: 'manage', label: 'Manage', tags: t('inventory_view', 'inventory_manage', 'stores') },
  ] },
  { key: 'purchase', label: 'Purchase', help: 'Purchase requests, quotes and purchase orders.', levels: [
    { key: 'manage', label: 'Manage', tags: t('purchase') },
  ] },
  { key: 'production', label: 'Production', help: 'Machines, operations, flows, planning, the tracker and the machine log.', levels: [
    { key: 'floor', label: 'Machine log only', tags: t('floor') },
    { key: 'view', label: 'View', tags: t('production_view') },
    { key: 'viewfloor', label: 'View and record work', tags: t('production_view', 'floor') },
    { key: 'manage', label: 'Manage and plan', tags: t('production_view', 'production_manage', 'floor') },
  ] },
  { key: 'maintenance', label: 'Maintenance', help: 'Machines board, tickets, preventive plans.', levels: [
    { key: 'manage', label: 'Manage', tags: t('maintenance') },
  ] },
  { key: 'accounts', label: 'Accounts', help: 'Billing, invoices, receipts and order costing.', levels: [
    { key: 'view', label: 'View', tags: t('accounts_view') },
    { key: 'manage', label: 'Manage', tags: t('accounts_view', 'accounts_manage') },
  ] },
];

export const approvals = [
  { tag: 'cf_erp_purchase_approve', label: 'Purchase requests' },
  { tag: 'cf_erp_approve_purchase_order', label: 'Purchase orders' },
  { tag: 'cf_erp_approve_contractor_po', label: 'Contractor POs' },
  { tag: 'cf_erp_approve_po_close_short', label: 'Closing a PO short' },
  { tag: 'cf_erp_approve_order_acceptance', label: 'Order acceptance' },
  { tag: 'cf_erp_approve_rate_change', label: 'Rate changes' },
  { tag: 'cf_erp_approve_month_plan', label: 'Month plan' },
  { tag: 'cf_erp_approve_rebaseline', label: 'Re-baseline' },
  { tag: 'cf_erp_approve_machine_purchase', label: 'New machine' },
  { tag: 'cf_erp_approve_machine_condemn', label: 'Condemn a machine' },
  { tag: 'cf_erp_approve_stock_count', label: 'Stock audit differences' },
  { tag: 'cf_erp_approve_reserved_planning', label: 'Using reserved stock (planning)' },
  { tag: 'cf_erp_approve_reserved_production', label: 'Using reserved stock (production)' },
  { tag: 'cf_erp_plate_change_approve', label: 'Plate changes' },
];

export const switches = [
  { key: 'management', label: 'Management', help: 'The MD dashboard, MD alerts, company settings, and deleting a sales order.', tags: t('md_dashboard', 'orders_delete') },
];

const everyApproval = approvals.map((a) => a.tag);
export const standardRoles = [
  { key: 'md', name: 'MD', help: 'Sees and decides everything.',
    levels: { sales: 'manage', parties: 'manage', catalog: 'setup', stores: 'manage', purchase: 'manage', production: 'manage', maintenance: 'manage', accounts: 'manage' },
    approvals: everyApproval, switches: ['management'] },
  { key: 'ppc', name: 'PPC', help: 'Plans and runs production.',
    levels: { sales: 'manage', catalog: 'view', stores: 'view', production: 'manage', maintenance: 'manage' }, approvals: [], switches: [] },
  { key: 'stores', name: 'Stores', help: 'Keeps the stock: receives, gives out, audits.',
    levels: { sales: 'view', catalog: 'view', stores: 'manage' }, approvals: ['cf_erp_purchase_approve'], switches: [] },
  { key: 'procurement', name: 'Procurement', help: 'Buys: requests, quotes, purchase orders, suppliers.',
    levels: { sales: 'view', parties: 'manage', catalog: 'view', stores: 'view', purchase: 'manage' }, approvals: [], switches: [] },
  { key: 'accounts', name: 'Accounts', help: 'Bills, records payments, reads costing.',
    levels: { sales: 'view', parties: 'manage', catalog: 'view', accounts: 'manage' }, approvals: [], switches: [] },
  { key: 'design', name: 'Design & materials', help: 'Builds the structure of an order and its materials.',
    levels: { sales: 'manage', parties: 'manage', catalog: 'manage', stores: 'view', purchase: 'manage', production: 'view' }, approvals: [], switches: [] },
  { key: 'floor', name: 'Floor Supervisor', help: 'Records work and stops on the shop floor.',
    levels: { sales: 'view', catalog: 'view', production: 'viewfloor' }, approvals: [], switches: [] },
  { key: 'maintenance', name: 'Maintenance', help: 'Looks after the machines.',
    levels: { catalog: 'view', production: 'view', maintenance: 'manage' }, approvals: [], switches: [] },
];

export default { departments, approvals, switches, standardRoles };
