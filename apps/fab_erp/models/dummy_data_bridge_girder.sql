-- =============================================================================
-- Dummy data: bridge / girder fabrication company (starhub, company_id = 1)
-- Plants, resources, stock locations, suppliers, raw-material item catalog,
-- GRNs (posted) with batches, stock ledger entries, balances and policies.
--
-- Ad-hoc script — not run automatically. Import manually:
--   mysql -u root -p1234 sqldb < dummy_data_bridge_girder.sql
-- =============================================================================

SET @companyId = 1; -- starhub

-- =============================================================================
-- 1. PLANTS
-- =============================================================================
INSERT INTO fab_plants (company_id, name, code) VALUES
  (@companyId, 'Main Fabrication Yard', 'MFY'),
  (@companyId, 'Girder Assembly Yard',  'GAY');

SET @plant1 = (SELECT id FROM fab_plants WHERE company_id = @companyId AND code = 'MFY');
SET @plant2 = (SELECT id FROM fab_plants WHERE company_id = @companyId AND code = 'GAY');

-- =============================================================================
-- 2. RESOURCE TYPES + RESOURCES
-- =============================================================================
INSERT INTO fab_resource_types (company_id, plant_id, name, code, category) VALUES
  (@companyId, @plant1, 'CNC Plasma Cutting',     'RT-PLASMA', 'Cutting'),
  (@companyId, @plant1, 'Plate Rolling Machine',  'RT-ROLL',   'Forming'),
  (@companyId, @plant1, 'Press Brake',            'RT-BRAKE',  'Forming'),
  (@companyId, @plant1, 'Submerged Arc Welding',  'RT-SAW',    'Welding'),
  (@companyId, @plant1, 'CNC Drilling Machine',   'RT-DRILL',  'Drilling'),
  (@companyId, @plant1, 'Shot Blasting Chamber',  'RT-BLAST',  'Surface Treatment'),
  (@companyId, @plant1, 'Painting Booth',         'RT-PAINT',  'Surface Treatment'),
  (@companyId, @plant1, 'EOT Crane',              'RT-CRANE1', 'Material Handling'),
  (@companyId, @plant2, 'MIG Welding Station',    'RT-MIG',    'Welding'),
  (@companyId, @plant2, 'Girder Assembly Jig',    'RT-JIG',    'Assembly'),
  (@companyId, @plant2, 'EOT Crane',              'RT-CRANE2', 'Material Handling');

SET @rt_plasma = (SELECT id FROM fab_resource_types WHERE company_id=@companyId AND code='RT-PLASMA');
SET @rt_roll   = (SELECT id FROM fab_resource_types WHERE company_id=@companyId AND code='RT-ROLL');
SET @rt_brake  = (SELECT id FROM fab_resource_types WHERE company_id=@companyId AND code='RT-BRAKE');
SET @rt_saw    = (SELECT id FROM fab_resource_types WHERE company_id=@companyId AND code='RT-SAW');
SET @rt_drill  = (SELECT id FROM fab_resource_types WHERE company_id=@companyId AND code='RT-DRILL');
SET @rt_blast  = (SELECT id FROM fab_resource_types WHERE company_id=@companyId AND code='RT-BLAST');
SET @rt_paint  = (SELECT id FROM fab_resource_types WHERE company_id=@companyId AND code='RT-PAINT');
SET @rt_crane1 = (SELECT id FROM fab_resource_types WHERE company_id=@companyId AND code='RT-CRANE1');
SET @rt_mig    = (SELECT id FROM fab_resource_types WHERE company_id=@companyId AND code='RT-MIG');
SET @rt_jig    = (SELECT id FROM fab_resource_types WHERE company_id=@companyId AND code='RT-JIG');
SET @rt_crane2 = (SELECT id FROM fab_resource_types WHERE company_id=@companyId AND code='RT-CRANE2');

INSERT INTO fab_resources (company_id, plant_id, resource_type_id, name, code) VALUES
  (@companyId, @plant1, @rt_plasma, 'CNC Plasma Cutter #1',     'PLASMA-1'),
  (@companyId, @plant1, @rt_roll,   'Plate Rolling Machine #1', 'ROLL-1'),
  (@companyId, @plant1, @rt_brake,  'Press Brake #1',           'BRAKE-1'),
  (@companyId, @plant1, @rt_saw,    'SAW Machine #1',           'SAW-1'),
  (@companyId, @plant1, @rt_saw,    'SAW Machine #2',           'SAW-2'),
  (@companyId, @plant1, @rt_drill,  'CNC Drill #1',             'DRILL-1'),
  (@companyId, @plant1, @rt_blast,  'Shot Blasting Chamber #1', 'BLAST-1'),
  (@companyId, @plant1, @rt_paint,  'Paint Booth #1',           'PAINT-1'),
  (@companyId, @plant1, @rt_crane1, 'EOT Crane 10T',            'CRANE-10T'),
  (@companyId, @plant2, @rt_mig,    'MIG Welding Station #1',   'MIG-1'),
  (@companyId, @plant2, @rt_mig,    'MIG Welding Station #2',   'MIG-2'),
  (@companyId, @plant2, @rt_jig,    'Girder Assembly Jig A',    'JIG-A'),
  (@companyId, @plant2, @rt_jig,    'Girder Assembly Jig B',    'JIG-B'),
  (@companyId, @plant2, @rt_crane2, 'EOT Crane 20T',            'CRANE-20T');

-- =============================================================================
-- 3. STOCK LOCATIONS
-- =============================================================================
INSERT INTO fab_stock_locations (company_id, plant_id, name, code, description) VALUES
  (@companyId, @plant1, 'Raw Material Yard',          'RM-YARD',     'Open yard for incoming plates, beams and sections'),
  (@companyId, @plant1, 'Plate Storage Shed',         'PLATE-STORE', 'Covered shed for cut plates and sheets'),
  (@companyId, @plant1, 'Welding Consumables Store',  'WELD-STORE',  'Electrodes, wire, flux and shielding gas'),
  (@companyId, @plant1, 'Fasteners Store',            'FAST-STORE',  'HSFG bolts, nuts and washers'),
  (@companyId, @plant1, 'Paint & Chemicals Store',    'PAINT-STORE', 'Primers, top coats and surface-prep chemicals'),
  (@companyId, @plant2, 'Steel Section Yard',         'SEC-YARD',    'Plates, beams and pipes for girder assembly'),
  (@companyId, @plant2, 'Girder Staging Area',        'GIRDER-STAGE','Assembled girder sections awaiting dispatch'),
  (@companyId, @plant2, 'Consumables Store',          'CONS-STORE2', 'Welding consumables for Girder Assembly Yard');

SET @loc_rm_yard     = (SELECT id FROM fab_stock_locations WHERE company_id=@companyId AND code='RM-YARD');
SET @loc_plate_store = (SELECT id FROM fab_stock_locations WHERE company_id=@companyId AND code='PLATE-STORE');
SET @loc_weld_store  = (SELECT id FROM fab_stock_locations WHERE company_id=@companyId AND code='WELD-STORE');
SET @loc_fast_store  = (SELECT id FROM fab_stock_locations WHERE company_id=@companyId AND code='FAST-STORE');
SET @loc_paint_store = (SELECT id FROM fab_stock_locations WHERE company_id=@companyId AND code='PAINT-STORE');
SET @loc_sec_yard    = (SELECT id FROM fab_stock_locations WHERE company_id=@companyId AND code='SEC-YARD');
SET @loc_girder_stage= (SELECT id FROM fab_stock_locations WHERE company_id=@companyId AND code='GIRDER-STAGE');
SET @loc_cons_store2 = (SELECT id FROM fab_stock_locations WHERE company_id=@companyId AND code='CONS-STORE2');

-- =============================================================================
-- 4. SUPPLIERS
-- =============================================================================
INSERT INTO fab_suppliers (company_id, name, code, contact_name, phone, email) VALUES
  (@companyId, 'Tata Steel Ltd',               'TATASTEEL', 'R. Kumar',     '9810000001', 'sales@tatasteel.example'),
  (@companyId, 'JSW Steel Ltd',                'JSWSTEEL',  'A. Mehta',     '9810000002', 'sales@jsw.example'),
  (@companyId, 'D&H Secheron Electrodes',      'DHSEC',     'S. Rao',       '9810000003', 'sales@dhsecheron.example'),
  (@companyId, 'Unbrako Fasteners India',      'UNBRAKO',   'P. Nair',      '9810000004', 'sales@unbrako.example'),
  (@companyId, 'Asian Paints PPG (Protective)','ASIANP',    'M. Iyer',      '9810000005', 'sales@asianpaints.example');

SET @sup_tata   = (SELECT id FROM fab_suppliers WHERE company_id=@companyId AND code='TATASTEEL');
SET @sup_jsw    = (SELECT id FROM fab_suppliers WHERE company_id=@companyId AND code='JSWSTEEL');
SET @sup_dhsec  = (SELECT id FROM fab_suppliers WHERE company_id=@companyId AND code='DHSEC');
SET @sup_unbrako= (SELECT id FROM fab_suppliers WHERE company_id=@companyId AND code='UNBRAKO');
SET @sup_asianp = (SELECT id FROM fab_suppliers WHERE company_id=@companyId AND code='ASIANP');

-- =============================================================================
-- 5. ITEM TAXONOMY — two company-custom subgroups for items with no exact fit
-- =============================================================================
INSERT INTO fab_item_subgroups (company_id, group_id, name, code, description, is_system)
SELECT @companyId, 7, 'Flux', 'flux', 'Submerged-arc welding flux', 0
WHERE NOT EXISTS (
  SELECT 1 FROM fab_item_subgroups WHERE company_id=@companyId AND group_id=7 AND code='flux'
);

INSERT INTO fab_item_subgroups (company_id, group_id, name, code, description, is_system)
SELECT @companyId, 11, 'Paints & Coatings', 'paint', 'Primers and top coats', 0
WHERE NOT EXISTS (
  SELECT 1 FROM fab_item_subgroups WHERE company_id=@companyId AND group_id=11 AND code='paint'
);

SET @sg_plate    = 8;  -- Raw Materials > Metals > Plate
SET @sg_bar      = 4;  -- Raw Materials > Metals > Bar Stock
SET @sg_pipe     = 6;  -- Raw Materials > Metals > Tube & Pipe
SET @sg_electrode= 20; -- Consumables > Welding Consumables > Electrodes
SET @sg_wire     = 22; -- Consumables > Welding Consumables > Welding Wire
SET @sg_gas      = 24; -- Consumables > Welding Consumables > Shielding Gas
SET @sg_flux     = (SELECT id FROM fab_item_subgroups WHERE company_id=@companyId AND group_id=7 AND code='flux');
SET @sg_hexbolt  = 32; -- Fasteners & Hardware > Bolts & Screws > Hex Bolts
SET @sg_paint    = (SELECT id FROM fab_item_subgroups WHERE company_id=@companyId AND group_id=11 AND code='paint');

SET @cat_rm   = 2;  -- Raw Materials
SET @grp_met  = 1;  -- Metals
SET @cat_cons = 4;  -- Consumables
SET @grp_weld = 7;  -- Welding Consumables
SET @grp_adh  = 11; -- Adhesives & Sealants
SET @cat_fast = 6;  -- Fasteners & Hardware
SET @grp_bolt = 15; -- Bolts & Screws
SET @grp_nut  = 17; -- Nuts & Washers

-- =============================================================================
-- 6. ITEM CATALOG — raw materials, consumables, fasteners, coatings
-- =============================================================================
INSERT INTO fab_item_catalog (company_id, name, code, unit, description, category_id, group_id, subgroup_id) VALUES
  (@companyId, 'MS Plate 12mm IS2062 Gr E350', 'PL-12-E350',    'MT',  'Mild steel plate, 12mm, IS2062 Grade E350', @cat_rm, @grp_met, @sg_plate),
  (@companyId, 'MS Plate 20mm IS2062 Gr E350', 'PL-20-E350',    'MT',  'Mild steel plate, 20mm, IS2062 Grade E350', @cat_rm, @grp_met, @sg_plate),
  (@companyId, 'MS Plate 25mm IS2062 Gr E350', 'PL-25-E350',    'MT',  'Mild steel plate, 25mm, IS2062 Grade E350', @cat_rm, @grp_met, @sg_plate),
  (@companyId, 'ISMB 300 Beam',                'ISMB300',       'MT',  'Indian Standard Medium Weight Beam, 300mm', @cat_rm, @grp_met, @sg_bar),
  (@companyId, 'ISMC 200 Channel',             'ISMC200',       'MT',  'Indian Standard Medium Weight Channel, 200mm', @cat_rm, @grp_met, @sg_bar),
  (@companyId, 'ISA 75x75x8 Angle',            'ISA75',         'MT',  'Equal angle, 75x75x8mm', @cat_rm, @grp_met, @sg_bar),
  (@companyId, 'MS Pipe 100NB SCH40',          'PIPE100NB',     'MT',  'Mild steel pipe, 100NB, Schedule 40', @cat_rm, @grp_met, @sg_pipe),
  (@companyId, 'Welding Electrode E7018 4mm',  'E7018-4',       'kg',  'Low-hydrogen electrode, 4mm', @cat_cons, @grp_weld, @sg_electrode),
  (@companyId, 'SAW Wire EM12K 4mm',           'SAWWIRE-EM12K', 'kg',  'Submerged-arc welding wire, EM12K, 4mm', @cat_cons, @grp_weld, @sg_wire),
  (@companyId, 'SAW Flux SAW-1',               'SAWFLUX1',      'kg',  'Agglomerated flux for submerged-arc welding', @cat_cons, @grp_weld, @sg_flux),
  (@companyId, 'CO2 Shielding Gas Cylinder',   'CO2-CYL',       'cyl', 'CO2 shielding gas, 20kg cylinder', @cat_cons, @grp_weld, @sg_gas),
  (@companyId, 'HSFG Bolt M24x80 Gr 8.8',      'HSFG-M24x80',   'nos', 'High-strength friction-grip bolt, M24x80, Gr 8.8', @cat_fast, @grp_bolt, @sg_hexbolt),
  (@companyId, 'HSFG Nut M24',                 'HSFG-NUT-M24',  'nos', 'High-strength friction-grip nut, M24', @cat_fast, @grp_nut, NULL),
  (@companyId, 'HSFG Washer M24',              'HSFG-WASH-M24', 'nos', 'High-strength friction-grip washer, M24', @cat_fast, @grp_nut, NULL),
  (@companyId, 'Zinc Rich Epoxy Primer',       'PRIMER-ZN',     'ltr', 'Zinc-rich epoxy primer for structural steel', @cat_cons, @grp_adh, @sg_paint),
  (@companyId, 'Aliphatic PU Top Coat - Grey', 'PUTOP-GREY',    'ltr', 'Aliphatic polyurethane top coat, grey', @cat_cons, @grp_adh, @sg_paint);

SET @item_pl12   = (SELECT id FROM fab_item_catalog WHERE company_id=@companyId AND code='PL-12-E350');
SET @item_pl20   = (SELECT id FROM fab_item_catalog WHERE company_id=@companyId AND code='PL-20-E350');
SET @item_pl25   = (SELECT id FROM fab_item_catalog WHERE company_id=@companyId AND code='PL-25-E350');
SET @item_ismb300= (SELECT id FROM fab_item_catalog WHERE company_id=@companyId AND code='ISMB300');
SET @item_ismc200= (SELECT id FROM fab_item_catalog WHERE company_id=@companyId AND code='ISMC200');
SET @item_isa75  = (SELECT id FROM fab_item_catalog WHERE company_id=@companyId AND code='ISA75');
SET @item_pipe100= (SELECT id FROM fab_item_catalog WHERE company_id=@companyId AND code='PIPE100NB');
SET @item_e7018  = (SELECT id FROM fab_item_catalog WHERE company_id=@companyId AND code='E7018-4');
SET @item_sawwire= (SELECT id FROM fab_item_catalog WHERE company_id=@companyId AND code='SAWWIRE-EM12K');
SET @item_sawflux= (SELECT id FROM fab_item_catalog WHERE company_id=@companyId AND code='SAWFLUX1');
SET @item_co2    = (SELECT id FROM fab_item_catalog WHERE company_id=@companyId AND code='CO2-CYL');
SET @item_bolt   = (SELECT id FROM fab_item_catalog WHERE company_id=@companyId AND code='HSFG-M24x80');
SET @item_nut    = (SELECT id FROM fab_item_catalog WHERE company_id=@companyId AND code='HSFG-NUT-M24');
SET @item_washer = (SELECT id FROM fab_item_catalog WHERE company_id=@companyId AND code='HSFG-WASH-M24');
SET @item_primer = (SELECT id FROM fab_item_catalog WHERE company_id=@companyId AND code='PRIMER-ZN');
SET @item_putop  = (SELECT id FROM fab_item_catalog WHERE company_id=@companyId AND code='PUTOP-GREY');

-- =============================================================================
-- 7. GRNs + LINES + BATCHES + STOCK LEDGER  (mirrors grnService.postGrn logic)
-- =============================================================================

-- ── GRN-2026-0001: Tata Steel — plates into Raw Material Yard (Plant 1) ──────
INSERT INTO fab_grns (company_id, grn_number, grn_date, plant_id, stock_location_id, supplier_id, supplier_ref, notes, status)
VALUES (@companyId, 'GRN-2026-0001', '2026-05-10', @plant1, @loc_rm_yard, @sup_tata, 'TATA-INV-8821', 'First plate delivery for deck girder fabrication', 'posted');
SET @grn1 = LAST_INSERT_ID();

INSERT INTO fab_item_batches (company_id, catalog_item_id, plant_id, stock_location_id, batch_code, qty_on_hand, received_date) VALUES
  (@companyId, @item_pl12, @plant1, @loc_rm_yard, 'TATA-PL12-A', 25, '2026-05-10'),
  (@companyId, @item_pl20, @plant1, @loc_rm_yard, 'TATA-PL20-A', 18, '2026-05-10');
SET @b_pl12_a = (SELECT id FROM fab_item_batches WHERE company_id=@companyId AND catalog_item_id=@item_pl12 AND plant_id=@plant1 AND stock_location_id=@loc_rm_yard AND batch_code='TATA-PL12-A');
SET @b_pl20_a = (SELECT id FROM fab_item_batches WHERE company_id=@companyId AND catalog_item_id=@item_pl20 AND plant_id=@plant1 AND stock_location_id=@loc_rm_yard AND batch_code='TATA-PL20-A');

INSERT INTO fab_grn_lines (company_id, grn_id, catalog_item_id, batch_id, batch_code, qty, unit_cost) VALUES
  (@companyId, @grn1, @item_pl12, @b_pl12_a, 'TATA-PL12-A', 25, 62000),
  (@companyId, @grn1, @item_pl20, @b_pl20_a, 'TATA-PL20-A', 18, 63500);

INSERT INTO fab_stock_ledger (company_id, catalog_item_id, plant_id, stock_location_id, batch_id, batch_code, txn_type, qty, unit_cost, supplier_id, grn_id, grn_line_id, txn_date) VALUES
  (@companyId, @item_pl12, @plant1, @loc_rm_yard, @b_pl12_a, 'TATA-PL12-A', 'grn_receipt', 25, 62000, @sup_tata, @grn1, (SELECT id FROM fab_grn_lines WHERE grn_id=@grn1 AND batch_id=@b_pl12_a), '2026-05-10'),
  (@companyId, @item_pl20, @plant1, @loc_rm_yard, @b_pl20_a, 'TATA-PL20-A', 'grn_receipt', 18, 63500, @sup_tata, @grn1, (SELECT id FROM fab_grn_lines WHERE grn_id=@grn1 AND batch_id=@b_pl20_a), '2026-05-10');

-- ── GRN-2026-0002: JSW Steel — beams/channels/angles into Raw Material Yard (Plant 1) ──
INSERT INTO fab_grns (company_id, grn_number, grn_date, plant_id, stock_location_id, supplier_id, supplier_ref, notes, status)
VALUES (@companyId, 'GRN-2026-0002', '2026-05-12', @plant1, @loc_rm_yard, @sup_jsw, 'JSW-INV-4456', 'Structural sections for cross-girders', 'posted');
SET @grn2 = LAST_INSERT_ID();

INSERT INTO fab_item_batches (company_id, catalog_item_id, plant_id, stock_location_id, batch_code, qty_on_hand, received_date) VALUES
  (@companyId, @item_ismb300, @plant1, @loc_rm_yard, 'JSW-ISMB300-A', 40, '2026-05-12'),
  (@companyId, @item_ismc200, @plant1, @loc_rm_yard, 'JSW-ISMC200-A', 15, '2026-05-12'),
  (@companyId, @item_isa75,   @plant1, @loc_rm_yard, 'JSW-ISA75-A',    8, '2026-05-12');
SET @b_ismb300_a = (SELECT id FROM fab_item_batches WHERE company_id=@companyId AND catalog_item_id=@item_ismb300 AND plant_id=@plant1 AND stock_location_id=@loc_rm_yard AND batch_code='JSW-ISMB300-A');
SET @b_ismc200_a = (SELECT id FROM fab_item_batches WHERE company_id=@companyId AND catalog_item_id=@item_ismc200 AND plant_id=@plant1 AND stock_location_id=@loc_rm_yard AND batch_code='JSW-ISMC200-A');
SET @b_isa75_a   = (SELECT id FROM fab_item_batches WHERE company_id=@companyId AND catalog_item_id=@item_isa75   AND plant_id=@plant1 AND stock_location_id=@loc_rm_yard AND batch_code='JSW-ISA75-A');

INSERT INTO fab_grn_lines (company_id, grn_id, catalog_item_id, batch_id, batch_code, qty, unit_cost) VALUES
  (@companyId, @grn2, @item_ismb300, @b_ismb300_a, 'JSW-ISMB300-A', 40, 64000),
  (@companyId, @grn2, @item_ismc200, @b_ismc200_a, 'JSW-ISMC200-A', 15, 64500),
  (@companyId, @grn2, @item_isa75,   @b_isa75_a,   'JSW-ISA75-A',    8, 65000);

INSERT INTO fab_stock_ledger (company_id, catalog_item_id, plant_id, stock_location_id, batch_id, batch_code, txn_type, qty, unit_cost, supplier_id, grn_id, grn_line_id, txn_date) VALUES
  (@companyId, @item_ismb300, @plant1, @loc_rm_yard, @b_ismb300_a, 'JSW-ISMB300-A', 'grn_receipt', 40, 64000, @sup_jsw, @grn2, (SELECT id FROM fab_grn_lines WHERE grn_id=@grn2 AND batch_id=@b_ismb300_a), '2026-05-12'),
  (@companyId, @item_ismc200, @plant1, @loc_rm_yard, @b_ismc200_a, 'JSW-ISMC200-A', 'grn_receipt', 15, 64500, @sup_jsw, @grn2, (SELECT id FROM fab_grn_lines WHERE grn_id=@grn2 AND batch_id=@b_ismc200_a), '2026-05-12'),
  (@companyId, @item_isa75,   @plant1, @loc_rm_yard, @b_isa75_a,   'JSW-ISA75-A',   'grn_receipt',  8, 65000, @sup_jsw, @grn2, (SELECT id FROM fab_grn_lines WHERE grn_id=@grn2 AND batch_id=@b_isa75_a),   '2026-05-12');

-- ── GRN-2026-0003: D&H Secheron — welding consumables into Welding Consumables Store (Plant 1) ──
INSERT INTO fab_grns (company_id, grn_number, grn_date, plant_id, stock_location_id, supplier_id, supplier_ref, notes, status)
VALUES (@companyId, 'GRN-2026-0003', '2026-05-15', @plant1, @loc_weld_store, @sup_dhsec, 'DHS-INV-1123', 'Welding consumables restock', 'posted');
SET @grn3 = LAST_INSERT_ID();

INSERT INTO fab_item_batches (company_id, catalog_item_id, plant_id, stock_location_id, batch_code, qty_on_hand, received_date) VALUES
  (@companyId, @item_e7018,   @plant1, @loc_weld_store, 'DHS-E7018-A',    500, '2026-05-15'),
  (@companyId, @item_sawwire, @plant1, @loc_weld_store, 'DHS-SAWWIRE-A',  800, '2026-05-15'),
  (@companyId, @item_sawflux, @plant1, @loc_weld_store, 'DHS-FLUX-A',     600, '2026-05-15'),
  (@companyId, @item_co2,     @plant1, @loc_weld_store, 'DHS-CO2-A',       20, '2026-05-15');
SET @b_e7018_a   = (SELECT id FROM fab_item_batches WHERE company_id=@companyId AND catalog_item_id=@item_e7018   AND plant_id=@plant1 AND stock_location_id=@loc_weld_store AND batch_code='DHS-E7018-A');
SET @b_sawwire_a = (SELECT id FROM fab_item_batches WHERE company_id=@companyId AND catalog_item_id=@item_sawwire AND plant_id=@plant1 AND stock_location_id=@loc_weld_store AND batch_code='DHS-SAWWIRE-A');
SET @b_sawflux_a = (SELECT id FROM fab_item_batches WHERE company_id=@companyId AND catalog_item_id=@item_sawflux AND plant_id=@plant1 AND stock_location_id=@loc_weld_store AND batch_code='DHS-FLUX-A');
SET @b_co2_a     = (SELECT id FROM fab_item_batches WHERE company_id=@companyId AND catalog_item_id=@item_co2     AND plant_id=@plant1 AND stock_location_id=@loc_weld_store AND batch_code='DHS-CO2-A');

INSERT INTO fab_grn_lines (company_id, grn_id, catalog_item_id, batch_id, batch_code, qty, unit_cost) VALUES
  (@companyId, @grn3, @item_e7018,   @b_e7018_a,   'DHS-E7018-A',   500, 145),
  (@companyId, @grn3, @item_sawwire, @b_sawwire_a, 'DHS-SAWWIRE-A', 800, 130),
  (@companyId, @grn3, @item_sawflux, @b_sawflux_a, 'DHS-FLUX-A',    600, 85),
  (@companyId, @grn3, @item_co2,     @b_co2_a,     'DHS-CO2-A',      20, 850);

INSERT INTO fab_stock_ledger (company_id, catalog_item_id, plant_id, stock_location_id, batch_id, batch_code, txn_type, qty, unit_cost, supplier_id, grn_id, grn_line_id, txn_date) VALUES
  (@companyId, @item_e7018,   @plant1, @loc_weld_store, @b_e7018_a,   'DHS-E7018-A',   'grn_receipt', 500, 145, @sup_dhsec, @grn3, (SELECT id FROM fab_grn_lines WHERE grn_id=@grn3 AND batch_id=@b_e7018_a),   '2026-05-15'),
  (@companyId, @item_sawwire, @plant1, @loc_weld_store, @b_sawwire_a, 'DHS-SAWWIRE-A', 'grn_receipt', 800, 130, @sup_dhsec, @grn3, (SELECT id FROM fab_grn_lines WHERE grn_id=@grn3 AND batch_id=@b_sawwire_a), '2026-05-15'),
  (@companyId, @item_sawflux, @plant1, @loc_weld_store, @b_sawflux_a, 'DHS-FLUX-A',    'grn_receipt', 600, 85,  @sup_dhsec, @grn3, (SELECT id FROM fab_grn_lines WHERE grn_id=@grn3 AND batch_id=@b_sawflux_a), '2026-05-15'),
  (@companyId, @item_co2,     @plant1, @loc_weld_store, @b_co2_a,     'DHS-CO2-A',     'grn_receipt',  20, 850, @sup_dhsec, @grn3, (SELECT id FROM fab_grn_lines WHERE grn_id=@grn3 AND batch_id=@b_co2_a),     '2026-05-15');

-- ── GRN-2026-0004: Unbrako — HSFG fasteners into Fasteners Store (Plant 1) ──
INSERT INTO fab_grns (company_id, grn_number, grn_date, plant_id, stock_location_id, supplier_id, supplier_ref, notes, status)
VALUES (@companyId, 'GRN-2026-0004', '2026-05-18', @plant1, @loc_fast_store, @sup_unbrako, 'UNB-INV-7790', 'HSFG bolt sets for field-splice connections', 'posted');
SET @grn4 = LAST_INSERT_ID();

INSERT INTO fab_item_batches (company_id, catalog_item_id, plant_id, stock_location_id, batch_code, qty_on_hand, received_date) VALUES
  (@companyId, @item_bolt,   @plant1, @loc_fast_store, 'UNB-BOLT-A', 2000, '2026-05-18'),
  (@companyId, @item_nut,    @plant1, @loc_fast_store, 'UNB-NUT-A',  2000, '2026-05-18'),
  (@companyId, @item_washer, @plant1, @loc_fast_store, 'UNB-WASH-A', 4000, '2026-05-18');
SET @b_bolt_a   = (SELECT id FROM fab_item_batches WHERE company_id=@companyId AND catalog_item_id=@item_bolt   AND plant_id=@plant1 AND stock_location_id=@loc_fast_store AND batch_code='UNB-BOLT-A');
SET @b_nut_a    = (SELECT id FROM fab_item_batches WHERE company_id=@companyId AND catalog_item_id=@item_nut    AND plant_id=@plant1 AND stock_location_id=@loc_fast_store AND batch_code='UNB-NUT-A');
SET @b_washer_a = (SELECT id FROM fab_item_batches WHERE company_id=@companyId AND catalog_item_id=@item_washer AND plant_id=@plant1 AND stock_location_id=@loc_fast_store AND batch_code='UNB-WASH-A');

INSERT INTO fab_grn_lines (company_id, grn_id, catalog_item_id, batch_id, batch_code, qty, unit_cost) VALUES
  (@companyId, @grn4, @item_bolt,   @b_bolt_a,   'UNB-BOLT-A', 2000, 95),
  (@companyId, @grn4, @item_nut,    @b_nut_a,    'UNB-NUT-A',  2000, 28),
  (@companyId, @grn4, @item_washer, @b_washer_a, 'UNB-WASH-A', 4000, 8);

INSERT INTO fab_stock_ledger (company_id, catalog_item_id, plant_id, stock_location_id, batch_id, batch_code, txn_type, qty, unit_cost, supplier_id, grn_id, grn_line_id, txn_date) VALUES
  (@companyId, @item_bolt,   @plant1, @loc_fast_store, @b_bolt_a,   'UNB-BOLT-A', 'grn_receipt', 2000, 95, @sup_unbrako, @grn4, (SELECT id FROM fab_grn_lines WHERE grn_id=@grn4 AND batch_id=@b_bolt_a),   '2026-05-18'),
  (@companyId, @item_nut,    @plant1, @loc_fast_store, @b_nut_a,    'UNB-NUT-A',  'grn_receipt', 2000, 28, @sup_unbrako, @grn4, (SELECT id FROM fab_grn_lines WHERE grn_id=@grn4 AND batch_id=@b_nut_a),    '2026-05-18'),
  (@companyId, @item_washer, @plant1, @loc_fast_store, @b_washer_a, 'UNB-WASH-A', 'grn_receipt', 4000, 8,  @sup_unbrako, @grn4, (SELECT id FROM fab_grn_lines WHERE grn_id=@grn4 AND batch_id=@b_washer_a), '2026-05-18');

-- ── GRN-2026-0005: Asian Paints — primer/top coat into Paint & Chemicals Store (Plant 1) ──
INSERT INTO fab_grns (company_id, grn_number, grn_date, plant_id, stock_location_id, supplier_id, supplier_ref, notes, status)
VALUES (@companyId, 'GRN-2026-0005', '2026-05-20', @plant1, @loc_paint_store, @sup_asianp, 'AP-INV-3321', 'Protective coating system for fabricated girders', 'posted');
SET @grn5 = LAST_INSERT_ID();

INSERT INTO fab_item_batches (company_id, catalog_item_id, plant_id, stock_location_id, batch_code, qty_on_hand, received_date) VALUES
  (@companyId, @item_primer, @plant1, @loc_paint_store, 'AP-PRIMER-A', 200, '2026-05-20'),
  (@companyId, @item_putop,  @plant1, @loc_paint_store, 'AP-PUTOP-A',  150, '2026-05-20');
SET @b_primer_a = (SELECT id FROM fab_item_batches WHERE company_id=@companyId AND catalog_item_id=@item_primer AND plant_id=@plant1 AND stock_location_id=@loc_paint_store AND batch_code='AP-PRIMER-A');
SET @b_putop_a  = (SELECT id FROM fab_item_batches WHERE company_id=@companyId AND catalog_item_id=@item_putop  AND plant_id=@plant1 AND stock_location_id=@loc_paint_store AND batch_code='AP-PUTOP-A');

INSERT INTO fab_grn_lines (company_id, grn_id, catalog_item_id, batch_id, batch_code, qty, unit_cost) VALUES
  (@companyId, @grn5, @item_primer, @b_primer_a, 'AP-PRIMER-A', 200, 420),
  (@companyId, @grn5, @item_putop,  @b_putop_a,  'AP-PUTOP-A',  150, 580);

INSERT INTO fab_stock_ledger (company_id, catalog_item_id, plant_id, stock_location_id, batch_id, batch_code, txn_type, qty, unit_cost, supplier_id, grn_id, grn_line_id, txn_date) VALUES
  (@companyId, @item_primer, @plant1, @loc_paint_store, @b_primer_a, 'AP-PRIMER-A', 'grn_receipt', 200, 420, @sup_asianp, @grn5, (SELECT id FROM fab_grn_lines WHERE grn_id=@grn5 AND batch_id=@b_primer_a), '2026-05-20'),
  (@companyId, @item_putop,  @plant1, @loc_paint_store, @b_putop_a,  'AP-PUTOP-A',  'grn_receipt', 150, 580, @sup_asianp, @grn5, (SELECT id FROM fab_grn_lines WHERE grn_id=@grn5 AND batch_id=@b_putop_a),  '2026-05-20');

-- ── GRN-2026-0006: JSW Steel — plates/pipe/beam into Steel Section Yard (Plant 2) ──
INSERT INTO fab_grns (company_id, grn_number, grn_date, plant_id, stock_location_id, supplier_id, supplier_ref, notes, status)
VALUES (@companyId, 'GRN-2026-0006', '2026-05-22', @plant2, @loc_sec_yard, @sup_jsw, 'JSW-INV-4502', 'Material transfer for girder assembly yard', 'posted');
SET @grn6 = LAST_INSERT_ID();

INSERT INTO fab_item_batches (company_id, catalog_item_id, plant_id, stock_location_id, batch_code, qty_on_hand, received_date) VALUES
  (@companyId, @item_pl25,    @plant2, @loc_sec_yard, 'JSW-PL25-A',     30, '2026-05-22'),
  (@companyId, @item_pipe100, @plant2, @loc_sec_yard, 'JSW-PIPE100-A',   5, '2026-05-22'),
  (@companyId, @item_ismb300, @plant2, @loc_sec_yard, 'JSW-ISMB300-B', 20, '2026-05-22');
SET @b_pl25_a     = (SELECT id FROM fab_item_batches WHERE company_id=@companyId AND catalog_item_id=@item_pl25    AND plant_id=@plant2 AND stock_location_id=@loc_sec_yard AND batch_code='JSW-PL25-A');
SET @b_pipe100_a  = (SELECT id FROM fab_item_batches WHERE company_id=@companyId AND catalog_item_id=@item_pipe100 AND plant_id=@plant2 AND stock_location_id=@loc_sec_yard AND batch_code='JSW-PIPE100-A');
SET @b_ismb300_b  = (SELECT id FROM fab_item_batches WHERE company_id=@companyId AND catalog_item_id=@item_ismb300 AND plant_id=@plant2 AND stock_location_id=@loc_sec_yard AND batch_code='JSW-ISMB300-B');

INSERT INTO fab_grn_lines (company_id, grn_id, catalog_item_id, batch_id, batch_code, qty, unit_cost) VALUES
  (@companyId, @grn6, @item_pl25,    @b_pl25_a,    'JSW-PL25-A',    30, 66000),
  (@companyId, @grn6, @item_pipe100, @b_pipe100_a, 'JSW-PIPE100-A',  5, 68000),
  (@companyId, @grn6, @item_ismb300, @b_ismb300_b, 'JSW-ISMB300-B', 20, 64200);

INSERT INTO fab_stock_ledger (company_id, catalog_item_id, plant_id, stock_location_id, batch_id, batch_code, txn_type, qty, unit_cost, supplier_id, grn_id, grn_line_id, txn_date) VALUES
  (@companyId, @item_pl25,    @plant2, @loc_sec_yard, @b_pl25_a,    'JSW-PL25-A',    'grn_receipt', 30, 66000, @sup_jsw, @grn6, (SELECT id FROM fab_grn_lines WHERE grn_id=@grn6 AND batch_id=@b_pl25_a),    '2026-05-22'),
  (@companyId, @item_pipe100, @plant2, @loc_sec_yard, @b_pipe100_a, 'JSW-PIPE100-A', 'grn_receipt',  5, 68000, @sup_jsw, @grn6, (SELECT id FROM fab_grn_lines WHERE grn_id=@grn6 AND batch_id=@b_pipe100_a), '2026-05-22'),
  (@companyId, @item_ismb300, @plant2, @loc_sec_yard, @b_ismb300_b, 'JSW-ISMB300-B', 'grn_receipt', 20, 64200, @sup_jsw, @grn6, (SELECT id FROM fab_grn_lines WHERE grn_id=@grn6 AND batch_id=@b_ismb300_b), '2026-05-22');

-- ── GRN-2026-0007: Tata Steel — second receipt into same batch (TATA-PL12-A) ──
INSERT INTO fab_grns (company_id, grn_number, grn_date, plant_id, stock_location_id, supplier_id, supplier_ref, notes, status)
VALUES (@companyId, 'GRN-2026-0007', '2026-06-01', @plant1, @loc_rm_yard, @sup_tata, 'TATA-INV-8902', 'Top-up delivery for 12mm deck plate batch', 'posted');
SET @grn7 = LAST_INSERT_ID();

UPDATE fab_item_batches SET qty_on_hand = qty_on_hand + 10 WHERE id = @b_pl12_a;

INSERT INTO fab_grn_lines (company_id, grn_id, catalog_item_id, batch_id, batch_code, qty, unit_cost) VALUES
  (@companyId, @grn7, @item_pl12, @b_pl12_a, 'TATA-PL12-A', 10, 62500);

INSERT INTO fab_stock_ledger (company_id, catalog_item_id, plant_id, stock_location_id, batch_id, batch_code, txn_type, qty, unit_cost, supplier_id, grn_id, grn_line_id, txn_date) VALUES
  (@companyId, @item_pl12, @plant1, @loc_rm_yard, @b_pl12_a, 'TATA-PL12-A', 'grn_receipt', 10, 62500, @sup_tata, @grn7, (SELECT id FROM fab_grn_lines WHERE grn_id=@grn7 AND batch_id=@b_pl12_a AND qty=10), '2026-06-01');

-- =============================================================================
-- 8. STOCK BALANCES (on-order / earmarked) + STOCK POLICIES (min / reorder)
-- =============================================================================
INSERT INTO fab_stock_balances (company_id, catalog_item_id, plant_id, stock_location_id, qty_ordered, qty_earmarked) VALUES
  (@companyId, @item_pl12,   @plant1, @loc_rm_yard,    15, 10),
  (@companyId, @item_ismb300,@plant1, @loc_rm_yard,    20, 15),
  (@companyId, @item_e7018,  @plant1, @loc_weld_store, 100, 50),
  (@companyId, @item_bolt,   @plant1, @loc_fast_store, 1000, 500);

INSERT INTO fab_stock_policies (company_id, catalog_item_id, plant_id, stock_location_id, min_qty, reorder_qty) VALUES
  (@companyId, @item_pl12,    @plant1, @loc_rm_yard,    10,  20),
  (@companyId, @item_pl20,    @plant1, @loc_rm_yard,     8,  15),
  (@companyId, @item_ismb300, @plant1, @loc_rm_yard,    15,  25),
  (@companyId, @item_e7018,   @plant1, @loc_weld_store, 100, 200),
  (@companyId, @item_sawwire, @plant1, @loc_weld_store, 150, 300),
  (@companyId, @item_bolt,    @plant1, @loc_fast_store, 500, 1000),
  (@companyId, @item_primer,  @plant1, @loc_paint_store, 50, 100),
  (@companyId, @item_pl25,    @plant2, @loc_sec_yard,    10,  20),
  (@companyId, @item_ismb300, @plant2, @loc_sec_yard,    10,  20);

-- =============================================================================
-- 9. RESOURCE -> STOCK LOCATION MAPPING (plant + stock location per resource)
-- =============================================================================
UPDATE fab_resources SET stock_location_id = @loc_rm_yard     WHERE company_id=@companyId AND code='PLASMA-1';
UPDATE fab_resources SET stock_location_id = @loc_plate_store WHERE company_id=@companyId AND code='ROLL-1';
UPDATE fab_resources SET stock_location_id = @loc_plate_store WHERE company_id=@companyId AND code='BRAKE-1';
UPDATE fab_resources SET stock_location_id = @loc_weld_store  WHERE company_id=@companyId AND code='SAW-1';
UPDATE fab_resources SET stock_location_id = @loc_weld_store  WHERE company_id=@companyId AND code='SAW-2';
UPDATE fab_resources SET stock_location_id = @loc_plate_store WHERE company_id=@companyId AND code='DRILL-1';
UPDATE fab_resources SET stock_location_id = @loc_paint_store WHERE company_id=@companyId AND code='BLAST-1';
UPDATE fab_resources SET stock_location_id = @loc_paint_store WHERE company_id=@companyId AND code='PAINT-1';
UPDATE fab_resources SET stock_location_id = @loc_rm_yard     WHERE company_id=@companyId AND code='CRANE-10T';
UPDATE fab_resources SET stock_location_id = @loc_cons_store2 WHERE company_id=@companyId AND code='MIG-1';
UPDATE fab_resources SET stock_location_id = @loc_cons_store2 WHERE company_id=@companyId AND code='MIG-2';
UPDATE fab_resources SET stock_location_id = @loc_girder_stage WHERE company_id=@companyId AND code='JIG-A';
UPDATE fab_resources SET stock_location_id = @loc_girder_stage WHERE company_id=@companyId AND code='JIG-B';
UPDATE fab_resources SET stock_location_id = @loc_sec_yard    WHERE company_id=@companyId AND code='CRANE-20T';
