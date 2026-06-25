-- FabFlow Demo Seed: BVEPL Bridge 1104A Project
-- Company: StartHub (id=1, slug=starhub)
-- Run once to create a realistic demo dataset.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Register fab_flow app for company 1
-- ─────────────────────────────────────────────────────────────────────────────
INSERT IGNORE INTO apps (company_id, name, slug) VALUES (1, 'FabFlow', 'fab_flow');

SET @app_id = (SELECT id FROM apps WHERE slug = 'fab_flow' AND company_id = 1 LIMIT 1);

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Create fab_project_manager role for company 1
-- ─────────────────────────────────────────────────────────────────────────────
INSERT IGNORE INTO roles (name, company_id) VALUES ('fab_project_manager', 1);
SET @pm_role_id = (SELECT id FROM roles WHERE name = 'fab_project_manager' AND company_id = 1 LIMIT 1);

-- Map pm role → fab_project_manager capability
SET @pm_cap_id = (SELECT capability_id FROM features_capability WHERE name = 'fab_project_manager' LIMIT 1);
INSERT IGNORE INTO role_capability (role_id, company_id, app_id, capability_id)
  VALUES (@pm_role_id, 1, @app_id, @pm_cap_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Create fab_user role for company 1
-- ─────────────────────────────────────────────────────────────────────────────
INSERT IGNORE INTO roles (name, company_id) VALUES ('fab_user', 1);
SET @fu_role_id = (SELECT id FROM roles WHERE name = 'fab_user' AND company_id = 1 LIMIT 1);

SET @fu_cap_id = (SELECT capability_id FROM features_capability WHERE name = 'fab_standard_user' LIMIT 1);
INSERT IGNORE INTO role_capability (role_id, company_id, app_id, capability_id)
  VALUES (@fu_role_id, 1, @app_id, @fu_cap_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. Create demo user: Rajesh Kumar (Project Manager)
-- Password: Test@1234
-- ─────────────────────────────────────────────────────────────────────────────
INSERT IGNORE INTO users (name, email, password, role_id, company_id)
VALUES (
  'Rajesh Kumar',
  'rajesh.kumar@starhub.com',
  '$2b$10$z1OpnhaB.NHdxBsV3de7z.Qu.o/L8rq8LizK2tGb8GeQHY/UWLLd6',
  @pm_role_id,
  1
);
SET @user_id = (SELECT id FROM users WHERE email = 'rajesh.kumar@starhub.com' LIMIT 1);

-- Grant user access to the fab_flow app with project manager role
INSERT IGNORE INTO app_user_access (user_id, app_id, role_id, company_id)
  VALUES (@user_id, @app_id, @pm_role_id, 1);

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. Create Project Plan
-- ─────────────────────────────────────────────────────────────────────────────
INSERT INTO fab_project_plans
  (project_code, project_name, client_name, site_location, plan_name, plan_revision,
   status, source, notes, company_id, created_by)
VALUES (
  'SCRGTL0071',
  'Road Over Bridge (ROB) - Bridge No. 1104A, NH km 180+359',
  'BVEPL (Border Villages Enhancement Project Limited)',
  'Railway km 579/14-16, Guntakal-Wadi Section, Guntakal Division, Karnataka',
  'Bridge 1104A — 36M Composite Girder Fabrication Plan',
  'Rev 0',
  'Draft',
  'Manual',
  '6-Lane composite girder bridge, 1×37.28m + 1×48.0m spans, 14° skew, 2.5% slope. IS 2062-2011 Grade E350. Guntakal Division, Southern Railway.',
  1,
  @user_id
);
SET @plan_id = LAST_INSERT_ID();

-- ─────────────────────────────────────────────────────────────────────────────
-- 6. Nodes — Level 0: Fabrication Package
-- ─────────────────────────────────────────────────────────────────────────────
INSERT INTO fab_nodes (project_plan_id, node_code, display_name, level_name, description, quantity, unit, drawing_ref, drawing_revision, material_grade, notes)
VALUES
(@plan_id, 'BRIDGE_1104A',   '36M Composite Girder System — Bridge 1104A', 'Fabrication Package',
 '1×37.28m composite girder bridge, 6 lanes, 14° skew, Guntakal Division', 1, 'Set', 'DRG-SCRGTL0071-GA-001', 'Rev A', 'IS 2062 E350',
 'Complete fabrication scope for Bridge 1104A ROB');

SET @root_id = LAST_INSERT_ID();

-- ─────────────────────────────────────────────────────────────────────────────
-- Level 1 packages
-- ─────────────────────────────────────────────────────────────────────────────
INSERT INTO fab_nodes (project_plan_id, node_code, display_name, level_name, description, quantity, unit, drawing_ref, drawing_revision, material_grade, notes) VALUES
(@plan_id, 'MG_PKG',   'Main Girder Package (G1–G6)',             'Package', '6 built-up I-girders, 37.28m span, welded plate construction',  6, 'Nos', 'DRG-SCRGTL0071-MG-001', 'Rev A', 'IS 2062 E350', '400×36 TF, 850×45 BF, 1550×16 Web'),
(@plan_id, 'ED_PKG',   'End Diaphragm Package',                   'Package', 'End diaphragms at both abutments, with bearing stiffeners',      10,'Nos', 'DRG-SCRGTL0071-ED-001', 'Rev A', 'IS 2062 E350', 'Includes BS1/BS2/BS3, pad plates, jack stiffeners'),
(@plan_id, 'ID_PKG',   'Intermediate Diaphragm Package',          'Package', 'Cross-frames between main girders at 5 bay locations',           30,'Nos', 'DRG-SCRGTL0071-ID-001', 'Rev A', 'IS 2062 E350', 'Includes IS1/IS2/IS3, corner plates, flange & side plates'),
(@plan_id, 'BLB_PKG',  'Bottom Lateral Bracing Package',          'Package', 'Bottom chord lateral bracing for girder stability during erection',115,'Nos','DRG-SCRGTL0071-BL-001', 'Rev A', 'IS 2062 E350', '14° skew geometry, BLB-1/2/3 members + gusset plates'),
(@plan_id, 'SPL_PKG',  'Splice Package',                          'Package', 'Field splice connections for top flange, bottom flange and web',  1, 'Lot', 'DRG-SCRGTL0071-SP-001', 'Rev A', 'IS 2062 E350', 'All flange and web splice plates included');

SET @mg_pkg  = (SELECT id FROM fab_nodes WHERE node_code='MG_PKG'  AND project_plan_id=@plan_id);
SET @ed_pkg  = (SELECT id FROM fab_nodes WHERE node_code='ED_PKG'  AND project_plan_id=@plan_id);
SET @id_pkg  = (SELECT id FROM fab_nodes WHERE node_code='ID_PKG'  AND project_plan_id=@plan_id);
SET @blb_pkg = (SELECT id FROM fab_nodes WHERE node_code='BLB_PKG' AND project_plan_id=@plan_id);
SET @spl_pkg = (SELECT id FROM fab_nodes WHERE node_code='SPL_PKG' AND project_plan_id=@plan_id);

-- Root → packages
INSERT INTO fab_node_relationships (project_plan_id, parent_node_id, child_node_id, quantity_required, relationship_type, is_primary) VALUES
(@plan_id, @root_id, @mg_pkg,  1, 'Assembly', 1),
(@plan_id, @root_id, @ed_pkg,  1, 'Assembly', 1),
(@plan_id, @root_id, @id_pkg,  1, 'Assembly', 1),
(@plan_id, @root_id, @blb_pkg, 1, 'Assembly', 1),
(@plan_id, @root_id, @spl_pkg, 1, 'Assembly', 1);

-- ─────────────────────────────────────────────────────────────────────────────
-- Level 2: Main Girder members
-- ─────────────────────────────────────────────────────────────────────────────
INSERT INTO fab_nodes (project_plan_id, node_code, display_name, level_name, description, quantity, unit, drawing_ref, drawing_revision, material_grade, profile, length_mm, width_mm, thickness_mm, weight_kg) VALUES
(@plan_id,'MG_G1','Main Girder G1','Girder Line','Built-up I-girder, near side — Span 1',1,'Nos','DRG-SCRGTL0071-MG-001','Rev A','IS 2062 E350','Built-up I',12330,NULL,NULL,NULL),
(@plan_id,'MG_G2','Main Girder G2','Girder Line','Built-up I-girder — Span 1',1,'Nos','DRG-SCRGTL0071-MG-001','Rev A','IS 2062 E350','Built-up I',12330,NULL,NULL,NULL),
(@plan_id,'MG_G3','Main Girder G3','Girder Line','Built-up I-girder — Span 1',1,'Nos','DRG-SCRGTL0071-MG-001','Rev A','IS 2062 E350','Built-up I',12240,NULL,NULL,NULL),
(@plan_id,'MG_G4','Main Girder G4','Girder Line','Built-up I-girder — Span 1',1,'Nos','DRG-SCRGTL0071-MG-001','Rev A','IS 2062 E350','Built-up I',12240,NULL,NULL,NULL),
(@plan_id,'MG_G5','Main Girder G5','Girder Line','Built-up I-girder — Span 1',1,'Nos','DRG-SCRGTL0071-MG-001','Rev A','IS 2062 E350','Built-up I',12330,NULL,NULL,NULL),
(@plan_id,'MG_G6','Main Girder G6','Girder Line','Built-up I-girder, far side — Span 1',1,'Nos','DRG-SCRGTL0071-MG-001','Rev A','IS 2062 E350','Built-up I',12330,NULL,NULL,NULL);

SET @mg_g1 = (SELECT id FROM fab_nodes WHERE node_code='MG_G1' AND project_plan_id=@plan_id);
SET @mg_g2 = (SELECT id FROM fab_nodes WHERE node_code='MG_G2' AND project_plan_id=@plan_id);
SET @mg_g3 = (SELECT id FROM fab_nodes WHERE node_code='MG_G3' AND project_plan_id=@plan_id);
SET @mg_g4 = (SELECT id FROM fab_nodes WHERE node_code='MG_G4' AND project_plan_id=@plan_id);
SET @mg_g5 = (SELECT id FROM fab_nodes WHERE node_code='MG_G5' AND project_plan_id=@plan_id);
SET @mg_g6 = (SELECT id FROM fab_nodes WHERE node_code='MG_G6' AND project_plan_id=@plan_id);

INSERT INTO fab_node_relationships (project_plan_id, parent_node_id, child_node_id, quantity_required, relationship_type, is_primary) VALUES
(@plan_id, @mg_pkg, @mg_g1, 1, 'Assembly', 1),
(@plan_id, @mg_pkg, @mg_g2, 1, 'Assembly', 1),
(@plan_id, @mg_pkg, @mg_g3, 1, 'Assembly', 1),
(@plan_id, @mg_pkg, @mg_g4, 1, 'Assembly', 1),
(@plan_id, @mg_pkg, @mg_g5, 1, 'Assembly', 1),
(@plan_id, @mg_pkg, @mg_g6, 1, 'Assembly', 1);

-- Level 3: Girder sub-parts (G1 as representative — same structure for all)
INSERT INTO fab_nodes (project_plan_id, node_code, display_name, level_name, description, quantity, unit, drawing_ref, drawing_revision, material_grade, profile, length_mm, width_mm, thickness_mm, weight_kg) VALUES
(@plan_id,'MG_G1_TF', 'G1 Top Flange Plate',    'Part', 'Top flange of Main Girder G1',  1,'Nos','DRG-SCRGTL0071-MG-001','Rev A','IS 2062 E350','Plate',12330,400,36,  1405),
(@plan_id,'MG_G1_BF', 'G1 Bottom Flange Plate', 'Part', 'Bottom flange of Main Girder G1',1,'Nos','DRG-SCRGTL0071-MG-001','Rev A','IS 2062 E350','Plate',12330,850,45,  3714),
(@plan_id,'MG_G1_WB', 'G1 Web Plate',            'Part', 'Web of Main Girder G1',          1,'Nos','DRG-SCRGTL0071-MG-001','Rev A','IS 2062 E350','Plate',12330,1550,16,2390);

SET @mg_g1_tf = (SELECT id FROM fab_nodes WHERE node_code='MG_G1_TF' AND project_plan_id=@plan_id);
SET @mg_g1_bf = (SELECT id FROM fab_nodes WHERE node_code='MG_G1_BF' AND project_plan_id=@plan_id);
SET @mg_g1_wb = (SELECT id FROM fab_nodes WHERE node_code='MG_G1_WB' AND project_plan_id=@plan_id);

INSERT INTO fab_node_relationships (project_plan_id, parent_node_id, child_node_id, quantity_required, relationship_type, is_primary) VALUES
(@plan_id, @mg_g1, @mg_g1_tf, 1, 'Component', 1),
(@plan_id, @mg_g1, @mg_g1_bf, 1, 'Component', 1),
(@plan_id, @mg_g1, @mg_g1_wb, 1, 'Component', 1);

-- ─────────────────────────────────────────────────────────────────────────────
-- Level 2: End Diaphragm members
-- ─────────────────────────────────────────────────────────────────────────────
INSERT INTO fab_nodes (project_plan_id, node_code, display_name, level_name, description, quantity, unit, drawing_ref, drawing_revision, material_grade, profile, length_mm, width_mm, thickness_mm, weight_kg) VALUES
(@plan_id,'ED_ASSY', 'End Diaphragm Assembly',       'Diaphragm Type','Single end diaphragm unit with all components', 10,'Nos','DRG-SCRGTL0071-ED-001','Rev A','IS 2062 E350','Built-up I',2778,NULL,NULL,NULL),
(@plan_id,'ED_WEB',  'ED Web Plate',                 'Part',          'End diaphragm web plate',                       10,'Nos','DRG-SCRGTL0071-ED-001','Rev A','IS 2062 E350','Plate',     2778,1275,12, 328),
(@plan_id,'ED_TF',   'ED Top & Bottom Flange Plates','Part',          'End diaphragm top and bottom flanges (pair)',   20,'Nos','DRG-SCRGTL0071-ED-001','Rev A','IS 2062 E350','Plate',     2418,200, 12,  69),
(@plan_id,'BS1',     'Bearing Stiffener BS1 (Plain)', 'Part',          'Plain stiffener plate at end diaphragm',         4,'Nos','DRG-SCRGTL0071-ED-001','Rev A','IS 2062 E350','Plate',     1550,190, 20,  92),
(@plan_id,'BS2',     'Bearing Stiffener BS2',         'Part',          'Bearing stiffener at abutment bearings',        10,'Nos','DRG-SCRGTL0071-ED-001','Rev A','IS 2062 E350','Plate',     1550,190, 20, 230),
(@plan_id,'BS3',     'Bearing Stiffener BS3',         'Part',          'Bearing stiffener at pier bearings',            10,'Nos','DRG-SCRGTL0071-ED-001','Rev A','IS 2062 E350','Plate',     1550,190, 20, 230),
(@plan_id,'PAD_PL',  'Pad Plate (Bearing)',           'Part',          'Bearing pad plate under stiffener foot',        20,'Nos','DRG-SCRGTL0071-ED-001','Rev A','IS 2062 E350','Plate',      180,100, 20,   3),
(@plan_id,'JACK_STF','Jack Stiffener Plate',          'Part',          'Stiffener plate at jacking points',             40,'Nos','DRG-SCRGTL0071-ED-001','Rev A','IS 2062 E350','Plate',     1275,90,  12,  14);

SET @ed_assy = (SELECT id FROM fab_nodes WHERE node_code='ED_ASSY' AND project_plan_id=@plan_id);
SET @ed_web  = (SELECT id FROM fab_nodes WHERE node_code='ED_WEB'  AND project_plan_id=@plan_id);
SET @ed_tf   = (SELECT id FROM fab_nodes WHERE node_code='ED_TF'   AND project_plan_id=@plan_id);
SET @bs1     = (SELECT id FROM fab_nodes WHERE node_code='BS1'     AND project_plan_id=@plan_id);
SET @bs2     = (SELECT id FROM fab_nodes WHERE node_code='BS2'     AND project_plan_id=@plan_id);
SET @bs3     = (SELECT id FROM fab_nodes WHERE node_code='BS3'     AND project_plan_id=@plan_id);
SET @pad_pl  = (SELECT id FROM fab_nodes WHERE node_code='PAD_PL'  AND project_plan_id=@plan_id);
SET @jack_st = (SELECT id FROM fab_nodes WHERE node_code='JACK_STF'AND project_plan_id=@plan_id);

INSERT INTO fab_node_relationships (project_plan_id, parent_node_id, child_node_id, quantity_required, relationship_type, is_primary) VALUES
(@plan_id, @ed_pkg,  @ed_assy, 10, 'Assembly',  1),
(@plan_id, @ed_assy, @ed_web,   1, 'Component', 1),
(@plan_id, @ed_assy, @ed_tf,    2, 'Component', 1),
(@plan_id, @ed_assy, @bs1,      1, 'Component', 1),
(@plan_id, @ed_assy, @bs2,      1, 'Component', 1),
(@plan_id, @ed_assy, @bs3,      1, 'Component', 1),
(@plan_id, @ed_assy, @pad_pl,   2, 'Component', 1),
(@plan_id, @ed_assy, @jack_st,  4, 'Component', 1);

-- ─────────────────────────────────────────────────────────────────────────────
-- Level 2: Intermediate Diaphragm members
-- ─────────────────────────────────────────────────────────────────────────────
INSERT INTO fab_nodes (project_plan_id, node_code, display_name, level_name, description, quantity, unit, drawing_ref, drawing_revision, material_grade, profile, length_mm, width_mm, thickness_mm, weight_kg) VALUES
(@plan_id,'ID_ASSY','Intermediate Diaphragm Assembly',      'Diaphragm Type','Single intermediate cross-frame unit',         30,'Nos','DRG-SCRGTL0071-ID-001','Rev A','IS 2062 E350','Built-up I',2778,NULL,NULL,NULL),
(@plan_id,'ID_WEB', 'ID Web Plate',                         'Part',          'Intermediate diaphragm web plate',              30,'Nos','DRG-SCRGTL0071-ID-001','Rev A','IS 2062 E350','Plate',2778,1275,12,328),
(@plan_id,'ID_TF',  'ID Top & Bottom Flange Plates',        'Part',          'Intermediate diaphragm top and bottom flanges', 60,'Nos','DRG-SCRGTL0071-ID-001','Rev A','IS 2062 E350','Plate',2478,200,12, 71),
(@plan_id,'IS1',    'Internal Stiffener IS1 (Plain)',        'Part',          'Plain internal stiffener',                     204,'Nos','DRG-SCRGTL0071-ID-001','Rev A','IS 2062 E350','Plate',1550,160,12, 23),
(@plan_id,'IS2',    'Internal Stiffener IS2',                'Part',          'Internal stiffener at diaphragm location',      30,'Nos','DRG-SCRGTL0071-ID-001','Rev A','IS 2062 E350','Plate',1550,160,12, 23),
(@plan_id,'IS3',    'Internal Stiffener IS3',                'Part',          'Internal stiffener alternate configuration',    30,'Nos','DRG-SCRGTL0071-ID-001','Rev A','IS 2062 E350','Plate',1550,160,12, 23),
(@plan_id,'DCP',    'Diaphragm Corner Plate',                'Part',          'Corner plate at diaphragm-to-girder junction', 120,'Nos','DRG-SCRGTL0071-ID-001','Rev A','IS 2062 E350','Plate', 106, 80,12,  1),
(@plan_id,'DFP',    'Diaphragm Flange Plate',                'Part',          'Flange plate connecting diaphragm to girder',   60,'Nos','DRG-SCRGTL0071-ID-001','Rev A','IS 2062 E350','Plate',1828, 80,12, 14),
(@plan_id,'DSP',    'Diaphragm Side Plate',                  'Part',          'Side plate at diaphragm ends',                  60,'Nos','DRG-SCRGTL0071-ID-001','Rev A','IS 2062 E350','Plate', 825, 80,12,  6);

SET @id_assy = (SELECT id FROM fab_nodes WHERE node_code='ID_ASSY' AND project_plan_id=@plan_id);
SET @id_web  = (SELECT id FROM fab_nodes WHERE node_code='ID_WEB'  AND project_plan_id=@plan_id);
SET @id_tf   = (SELECT id FROM fab_nodes WHERE node_code='ID_TF'   AND project_plan_id=@plan_id);
SET @is1     = (SELECT id FROM fab_nodes WHERE node_code='IS1'     AND project_plan_id=@plan_id);
SET @is2     = (SELECT id FROM fab_nodes WHERE node_code='IS2'     AND project_plan_id=@plan_id);
SET @is3     = (SELECT id FROM fab_nodes WHERE node_code='IS3'     AND project_plan_id=@plan_id);
SET @dcp     = (SELECT id FROM fab_nodes WHERE node_code='DCP'     AND project_plan_id=@plan_id);
SET @dfp     = (SELECT id FROM fab_nodes WHERE node_code='DFP'     AND project_plan_id=@plan_id);
SET @dsp     = (SELECT id FROM fab_nodes WHERE node_code='DSP'     AND project_plan_id=@plan_id);

INSERT INTO fab_node_relationships (project_plan_id, parent_node_id, child_node_id, quantity_required, relationship_type, is_primary) VALUES
(@plan_id, @id_pkg,  @id_assy, 30, 'Assembly',  1),
(@plan_id, @id_assy, @id_web,   1, 'Component', 1),
(@plan_id, @id_assy, @id_tf,    2, 'Component', 1),
(@plan_id, @id_assy, @is1,      7, 'Component', 1),
(@plan_id, @id_assy, @is2,      1, 'Component', 1),
(@plan_id, @id_assy, @is3,      1, 'Component', 1),
(@plan_id, @id_assy, @dcp,      4, 'Component', 1),
(@plan_id, @id_assy, @dfp,      2, 'Component', 1),
(@plan_id, @id_assy, @dsp,      2, 'Component', 1);

-- ─────────────────────────────────────────────────────────────────────────────
-- Level 2: Bottom Lateral Bracing members
-- ─────────────────────────────────────────────────────────────────────────────
INSERT INTO fab_nodes (project_plan_id, node_code, display_name, level_name, description, quantity, unit, drawing_ref, drawing_revision, material_grade, profile, length_mm, width_mm, thickness_mm, weight_kg) VALUES
(@plan_id,'BLB1','BLB-1 Bottom Lateral Bracing Member','Bracing Member','SHS section, diagonal brace — 14° skew geometry',57,'Nos','DRG-SCRGTL0071-BL-001','Rev A','IS 2062 E350','SHS 130×130×10',1857,130,130, 73),
(@plan_id,'BLB2','BLB-2 Bottom Lateral Bracing Member','Bracing Member','SHS section, longer diagonal brace',            54,'Nos','DRG-SCRGTL0071-BL-001','Rev A','IS 2062 E350','SHS 130×130×10',2252,130,130, 89),
(@plan_id,'BLB3','BLB-3 Bottom Lateral Bracing Member','Bracing Member','SHS section, end bay brace — shorter length',    4,'Nos','DRG-SCRGTL0071-BL-001','Rev A','IS 2062 E350','SHS 130×130×10',1607,130,130, 63),
(@plan_id,'GUS1','Gusset Plate GUS1',                  'Part',          'Connection gusset for BLB-1, with 14° cut',     114,'Nos','DRG-SCRGTL0071-BL-001','Rev A','IS 2062 E350','Plate',          475,150, 16,  9),
(@plan_id,'GUS2','Gusset Plate GUS2',                  'Part',          'Connection gusset for BLB-2, with 14° cut',     108,'Nos','DRG-SCRGTL0071-BL-001','Rev A','IS 2062 E350','Plate',          550,150, 16, 10);

SET @blb1 = (SELECT id FROM fab_nodes WHERE node_code='BLB1' AND project_plan_id=@plan_id);
SET @blb2 = (SELECT id FROM fab_nodes WHERE node_code='BLB2' AND project_plan_id=@plan_id);
SET @blb3 = (SELECT id FROM fab_nodes WHERE node_code='BLB3' AND project_plan_id=@plan_id);
SET @gus1 = (SELECT id FROM fab_nodes WHERE node_code='GUS1' AND project_plan_id=@plan_id);
SET @gus2 = (SELECT id FROM fab_nodes WHERE node_code='GUS2' AND project_plan_id=@plan_id);

INSERT INTO fab_node_relationships (project_plan_id, parent_node_id, child_node_id, quantity_required, relationship_type, is_primary) VALUES
(@plan_id, @blb_pkg, @blb1, 57, 'Assembly',  1),
(@plan_id, @blb_pkg, @blb2, 54, 'Assembly',  1),
(@plan_id, @blb_pkg, @blb3,  4, 'Assembly',  1),
(@plan_id, @blb_pkg, @gus1,114, 'Component', 1),
(@plan_id, @blb_pkg, @gus2,108, 'Component', 1);

-- ─────────────────────────────────────────────────────────────────────────────
-- Level 2: Splice members
-- ─────────────────────────────────────────────────────────────────────────────
INSERT INTO fab_nodes (project_plan_id, node_code, display_name, level_name, description, quantity, unit, drawing_ref, drawing_revision, material_grade, profile, length_mm, width_mm, thickness_mm, weight_kg) VALUES
(@plan_id,'TF_OSP','Top Flange Outer Splice Plate',     'Splice Plate','Outer cover plate for top flange field splice',  12,'Nos','DRG-SCRGTL0071-SP-001','Rev A','IS 2062 E350','Plate', 930,400,20,  58),
(@plan_id,'TF_ISP','Top Flange Inner Splice Plate',     'Splice Plate','Inner filler plate for top flange splice',       24,'Nos','DRG-SCRGTL0071-SP-001','Rev A','IS 2062 E350','Plate', 930,180,20,  26),
(@plan_id,'WB_SP', 'Web Splice Plate',                  'Splice Plate','Vertical web splice plate pair',                 24,'Nos','DRG-SCRGTL0071-SP-001','Rev A','IS 2062 E350','Plate',1360,660,16,  89),
(@plan_id,'BF_OSP','Bottom Flange Outer Splice Plate',  'Splice Plate','Outer cover plate for bottom flange splice',     12,'Nos','DRG-SCRGTL0071-SP-001','Rev A','IS 2062 E350','Plate', 880,850,36, 210),
(@plan_id,'BF_IS1','Bottom Flange Inner Splice PL Type 1','Splice Plate','Inner filler plate type 1 for bottom flange', 16,'Nos','DRG-SCRGTL0071-SP-001','Rev A','IS 2062 E350','Plate', 880,400,36,  99),
(@plan_id,'BF_IS2','Bottom Flange Inner Splice PL Type 2','Splice Plate','Inner filler plate type 2 for bottom flange',  8,'Nos','DRG-SCRGTL0071-SP-001','Rev A','IS 2062 E350','Plate', 880,725,36, 179);

SET @tf_osp = (SELECT id FROM fab_nodes WHERE node_code='TF_OSP' AND project_plan_id=@plan_id);
SET @tf_isp = (SELECT id FROM fab_nodes WHERE node_code='TF_ISP' AND project_plan_id=@plan_id);
SET @wb_sp  = (SELECT id FROM fab_nodes WHERE node_code='WB_SP'  AND project_plan_id=@plan_id);
SET @bf_osp = (SELECT id FROM fab_nodes WHERE node_code='BF_OSP' AND project_plan_id=@plan_id);
SET @bf_is1 = (SELECT id FROM fab_nodes WHERE node_code='BF_IS1' AND project_plan_id=@plan_id);
SET @bf_is2 = (SELECT id FROM fab_nodes WHERE node_code='BF_IS2' AND project_plan_id=@plan_id);

INSERT INTO fab_node_relationships (project_plan_id, parent_node_id, child_node_id, quantity_required, relationship_type, is_primary) VALUES
(@plan_id, @spl_pkg, @tf_osp, 12, 'Component', 1),
(@plan_id, @spl_pkg, @tf_isp, 24, 'Component', 1),
(@plan_id, @spl_pkg, @wb_sp,  24, 'Component', 1),
(@plan_id, @spl_pkg, @bf_osp, 12, 'Component', 1),
(@plan_id, @spl_pkg, @bf_is1, 16, 'Component', 1),
(@plan_id, @spl_pkg, @bf_is2,  8, 'Component', 1);

-- ─────────────────────────────────────────────────────────────────────────────
-- 7. Process Routes — Main Girder G1 (representative, full route)
-- ─────────────────────────────────────────────────────────────────────────────
INSERT INTO fab_node_process_routes
  (project_plan_id, node_id, process_step_code, sequence_no, parallel_group, process_name, process_type,
   machine_or_workcentre_type, estimated_time_value, estimated_time_unit, mandatory, drawing_ref, notes)
VALUES
(@plan_id,@mg_g1,'MG_G1_01', 10, NULL,'Plate Marking & Nesting',  'Marking',  'Marking Table',        45,'min',1,'DRG-SCRGTL0071-MG-001','Mark TF, BF, Web plates per nesting plan'),
(@plan_id,@mg_g1,'MG_G1_02', 20, NULL,'Flange Plate Cutting',     'Cutting',  'CNC Plasma / Oxy-Fuel',90,'min',1,'DRG-SCRGTL0071-MG-001','Cut 400×36 TF and 850×45 BF per DXF'),
(@plan_id,@mg_g1,'MG_G1_03', 30, NULL,'Web Plate Cutting',        'Cutting',  'CNC Plasma',           60,'min',1,'DRG-SCRGTL0071-MG-001','Cut 1550×16 web; leave 80mm bottom edge for controlled welding'),
(@plan_id,@mg_g1,'MG_G1_04', 40, NULL,'Flange Straightening',     'Fit-up',   'Press / Straightening Bay',30,'min',1,NULL,'Check and correct camber/bow in flanges after cutting'),
(@plan_id,@mg_g1,'MG_G1_05', 50, NULL,'Sub-Assembly Fit-up',      'Fit-up',   'Assembly Bay',        120,'min',1,'DRG-SCRGTL0071-MG-001','Tack-weld TF, BF, Web into I-section on jig. Check squareness'),
(@plan_id,@mg_g1,'MG_G1_06', 60, NULL,'SAW Fillet Welding — Web to Flange','SAW Welding','SAW Welding Machine',240,'min',1,'DRG-SCRGTL0071-MG-001','Submerged arc weld both sides web-to-flange. Note: bottom 80mm held'),
(@plan_id,@mg_g1,'MG_G1_07', 70, NULL,'Stiffener Fit-up',         'Fit-up',   'Assembly Bay',         90,'min',1,'DRG-SCRGTL0071-MG-001','Position and tack IS1/IS2/IS3, BS stiffeners per spacing plan'),
(@plan_id,@mg_g1,'MG_G1_08', 80, NULL,'Stiffener MIG Welding',    'MIG Welding','MIG Welding Station', 180,'min',1,'DRG-SCRGTL0071-MG-001','Fillet weld all stiffeners both sides 8mm fillet'),
(@plan_id,@mg_g1,'MG_G1_09', 90, NULL,'Shear Stud Welding',       'Stud Welding','Stud Welding Gun',  120,'min',1,'DRG-SCRGTL0071-MG-001','Weld ∅25mm shear studs to top flange per layout drawing'),
(@plan_id,@mg_g1,'MG_G1_10',100, NULL,'Dimensional Check',        'Inspection','QC Bay / Total Station',60,'min',1,'DRG-SCRGTL0071-MG-001','Check overall length ±3mm, camber, sweep, squareness'),
(@plan_id,@mg_g1,'MG_G1_11',110, NULL,'Weld Visual Inspection',   'Inspection','QC Bay',               45,'min',1,NULL,'Visual weld inspection per IS 822. Mark all defects for repair'),
(@plan_id,@mg_g1,'MG_G1_12',120, NULL,'Ultrasonic Testing (UT)',  'Inspection','UT Equipment',         60,'min',1,NULL,'UT on all full penetration butt welds. Grade B acceptance'),
(@plan_id,@mg_g1,'MG_G1_13',130, NULL,'Grinding & Repairs',       'Grinding',  'Angle Grinder',        45,'min',0,NULL,'Repair any UT/visual rejections; re-inspect'),
(@plan_id,@mg_g1,'MG_G1_14',140, NULL,'Grit Blasting Sa 2.5',     'Blasting',  'Shot Blast Chamber',   90,'min',1,NULL,'Blast to Sa 2.5 surface prep per IS 9954 before painting'),
(@plan_id,@mg_g1,'MG_G1_15',150, NULL,'Primer Coat Application',  'Painting',  'Paint Bay',            60,'min',1,NULL,'Apply 2-coat zinc phosphate primer, 75 microns DFT each'),
(@plan_id,@mg_g1,'MG_G1_16',160, NULL,'Final Dimensional Inspection','Inspection','QC Bay',             30,'min',1,NULL,'Final check against dispatch drawing. Record in QC docket');

-- ─────────────────────────────────────────────────────────────────────────────
-- Process Routes — BLB1 (bracing member, simpler route)
-- ─────────────────────────────────────────────────────────────────────────────
INSERT INTO fab_node_process_routes
  (project_plan_id, node_id, process_step_code, sequence_no, parallel_group, process_name, process_type,
   machine_or_workcentre_type, estimated_time_value, estimated_time_unit, mandatory, drawing_ref, notes)
VALUES
(@plan_id,@blb1,'BLB1_01',10, NULL,'SHS Cutting to Length',     'Cutting',   'Bandsaw / CNC Plasma',20,'min',1,'DRG-SCRGTL0071-BL-001','Cut 130×130×10 SHS to 1857mm ±1mm'),
(@plan_id,@blb1,'BLB1_02',20, 'P1','End Drilling',              'Drilling',  'Radial Drill',        15,'min',1,'DRG-SCRGTL0071-BL-001','Drill bolt holes per BLB hole spacing detail (14° skew)'),
(@plan_id,@blb1,'BLB1_03',20, 'P1','Deburring & Edge Dressing', 'Grinding',  'Grinding Station',    10,'min',1,NULL,'Deburr all holes; dress cut ends'),
(@plan_id,@blb1,'BLB1_04',30, NULL,'Gusset Fit & Tack',         'Fit-up',    'Assembly Bay',        25,'min',1,'DRG-SCRGTL0071-BL-001','Tack GUS1 gusset plates to SHS ends at correct skew angle'),
(@plan_id,@blb1,'BLB1_05',40, NULL,'Gusset Fillet Welding',     'MIG Welding','MIG Welding Station', 30,'min',1,'DRG-SCRGTL0071-BL-001','Weld gusset to SHS, 8mm fillet full perimeter both sides'),
(@plan_id,@blb1,'BLB1_06',50, NULL,'Part QC Inspection',        'Inspection','QC Bay',              10,'min',1,NULL,'Check dimensions, hole positions, weld quality');

-- ─────────────────────────────────────────────────────────────────────────────
-- Process Routes — End Diaphragm Assembly
-- ─────────────────────────────────────────────────────────────────────────────
INSERT INTO fab_node_process_routes
  (project_plan_id, node_id, process_step_code, sequence_no, parallel_group, process_name, process_type,
   machine_or_workcentre_type, estimated_time_value, estimated_time_unit, mandatory, drawing_ref, notes)
VALUES
(@plan_id,@ed_assy,'ED_01',10, NULL,'Plate Cutting — Web & Flanges', 'Cutting',    'CNC Plasma',       60,'min',1,'DRG-SCRGTL0071-ED-001','Cut 1275×12 web and 200×12 flanges per DXF'),
(@plan_id,@ed_assy,'ED_02',20, NULL,'Stiffener Cutting & Prep',      'Cutting',    'Bandsaw',          30,'min',1,'DRG-SCRGTL0071-ED-001','Cut BS1/BS2/BS3 plates, pad plates, jack stiffeners'),
(@plan_id,@ed_assy,'ED_03',30, NULL,'I-Section Fit-up',              'Fit-up',     'Assembly Jig',     60,'min',1,'DRG-SCRGTL0071-ED-001','Assemble web + flanges into I-section on jig'),
(@plan_id,@ed_assy,'ED_04',40, NULL,'Flange-to-Web Fillet Weld',     'MIG Welding','MIG Welding Station',90,'min',1,'DRG-SCRGTL0071-ED-001','4-pass 8mm fillet weld both sides'),
(@plan_id,@ed_assy,'ED_05',50, NULL,'Bearing Stiffener Fit-up',      'Fit-up',     'Assembly Bay',     45,'min',1,'DRG-SCRGTL0071-ED-001','Position BS1/BS2/BS3 stiffeners and tack'),
(@plan_id,@ed_assy,'ED_06',60, NULL,'Bearing Stiffener Welding',     'MIG Welding','MIG Welding Station',60,'min',1,'DRG-SCRGTL0071-ED-001','Full fillet weld, both sides of each stiffener'),
(@plan_id,@ed_assy,'ED_07',70, NULL,'Pad Plate & Jack Stiffener Weld','MIG Welding','MIG Welding Station',30,'min',1,'DRG-SCRGTL0071-ED-001','Weld pad plates and jack stiffeners in position'),
(@plan_id,@ed_assy,'ED_08',80, NULL,'Dimensional Inspection',         'Inspection', 'QC Bay',           30,'min',1,'DRG-SCRGTL0071-ED-001','Check overall dims, stiffener spacing, squareness'),
(@plan_id,@ed_assy,'ED_09',90, NULL,'Weld Inspection & Sign-off',     'Inspection', 'QC Bay',           20,'min',1,NULL,'Visual + DPT on bearing stiffener welds. QC sign-off');

-- ─────────────────────────────────────────────────────────────────────────────
-- Process Routes — Intermediate Diaphragm Assembly
-- ─────────────────────────────────────────────────────────────────────────────
INSERT INTO fab_node_process_routes
  (project_plan_id, node_id, process_step_code, sequence_no, parallel_group, process_name, process_type,
   machine_or_workcentre_type, estimated_time_value, estimated_time_unit, mandatory, drawing_ref, notes)
VALUES
(@plan_id,@id_assy,'ID_01',10, NULL,'Plate Cutting',              'Cutting',    'CNC Plasma',        50,'min',1,'DRG-SCRGTL0071-ID-001','Cut web, flanges, IS plates from nesting'),
(@plan_id,@id_assy,'ID_02',20, NULL,'Corner & Side Plate Cutting','Cutting',    'CNC Plasma',        20,'min',1,'DRG-SCRGTL0071-ID-001','Cut DCP, DFP, DSP components'),
(@plan_id,@id_assy,'ID_03',30, NULL,'I-Section Fit-up',           'Fit-up',     'Assembly Jig',      50,'min',1,'DRG-SCRGTL0071-ID-001','Assemble I-section, tack-weld'),
(@plan_id,@id_assy,'ID_04',40, NULL,'Fillet Welding',             'MIG Welding','MIG Welding Station',75,'min',1,'DRG-SCRGTL0071-ID-001','Weld flanges to web, 8mm fillet'),
(@plan_id,@id_assy,'ID_05',50, NULL,'Internal Stiffener Fit-up',  'Fit-up',     'Assembly Bay',      40,'min',1,'DRG-SCRGTL0071-ID-001','Position IS1/IS2/IS3 stiffeners'),
(@plan_id,@id_assy,'ID_06',60, NULL,'Stiffener Welding',          'MIG Welding','MIG Welding Station',50,'min',1,'DRG-SCRGTL0071-ID-001','Weld stiffeners both sides'),
(@plan_id,@id_assy,'ID_07',70, NULL,'Corner & Flange Plate Fit',  'Fit-up',     'Assembly Bay',      25,'min',1,'DRG-SCRGTL0071-ID-001','Fit DCP, DFP, DSP per drawing'),
(@plan_id,@id_assy,'ID_08',80, NULL,'Corner & Flange Plate Weld', 'MIG Welding','MIG Welding Station',35,'min',1,'DRG-SCRGTL0071-ID-001','Weld connection plates'),
(@plan_id,@id_assy,'ID_09',90, NULL,'QC Inspection',              'Inspection', 'QC Bay',            20,'min',1,NULL,'Dimensional check and weld visual');

-- ─────────────────────────────────────────────────────────────────────────────
-- Process Routes — Web Splice Plate (cutting & drilling only)
-- ─────────────────────────────────────────────────────────────────────────────
INSERT INTO fab_node_process_routes
  (project_plan_id, node_id, process_step_code, sequence_no, parallel_group, process_name, process_type,
   machine_or_workcentre_type, estimated_time_value, estimated_time_unit, mandatory, drawing_ref, notes)
VALUES
(@plan_id,@wb_sp,'WB_SP_01',10,NULL,'Plate Cutting','Cutting',  'CNC Plasma',15,'min',1,'DRG-SCRGTL0071-SP-001','Cut 660×16×1360mm web splice plates'),
(@plan_id,@wb_sp,'WB_SP_02',20,NULL,'Drilling',     'Drilling', 'CNC Drill',  25,'min',1,'DRG-SCRGTL0071-SP-001','Drill bolt pattern per splice detail, 8.8 grade HT bolts'),
(@plan_id,@wb_sp,'WB_SP_03',30,NULL,'Deburr & Mark','Grinding', 'Grinder',     8,'min',1,NULL,'Deburr holes, stamp mark number'),
(@plan_id,@wb_sp,'WB_SP_04',40,NULL,'Part QC',      'Inspection','QC Bay',     10,'min',1,NULL,'Check hole positions ±0.5mm, edge distances');

-- ─────────────────────────────────────────────────────────────────────────────
-- Verification query
-- ─────────────────────────────────────────────────────────────────────────────
SELECT 'Plan created:' AS msg, id, plan_name, plan_revision, status FROM fab_project_plans WHERE id = @plan_id;
SELECT COUNT(*) AS node_count         FROM fab_nodes                WHERE project_plan_id = @plan_id;
SELECT COUNT(*) AS relationship_count FROM fab_node_relationships   WHERE project_plan_id = @plan_id;
SELECT COUNT(*) AS process_step_count FROM fab_node_process_routes  WHERE project_plan_id = @plan_id;
SELECT 'User created:' AS msg, id, name, email FROM users WHERE email = 'rajesh.kumar@starhub.com';
