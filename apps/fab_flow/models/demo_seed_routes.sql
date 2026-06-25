-- Add process routes to all nodes that currently have none.
-- Plan id=1, company=starhub.
-- Run once after demo_seed.sql has already been executed.

SET @plan_id = 1;

-- ── Collect node IDs ──────────────────────────────────────────────────────────
SET @mg_g1   = (SELECT id FROM fab_nodes WHERE project_plan_id=@plan_id AND node_code='MG_G1');
SET @mg_g2   = (SELECT id FROM fab_nodes WHERE project_plan_id=@plan_id AND node_code='MG_G2');
SET @mg_g3   = (SELECT id FROM fab_nodes WHERE project_plan_id=@plan_id AND node_code='MG_G3');
SET @mg_g4   = (SELECT id FROM fab_nodes WHERE project_plan_id=@plan_id AND node_code='MG_G4');
SET @mg_g5   = (SELECT id FROM fab_nodes WHERE project_plan_id=@plan_id AND node_code='MG_G5');
SET @mg_g6   = (SELECT id FROM fab_nodes WHERE project_plan_id=@plan_id AND node_code='MG_G6');

SET @mg_g1_tf = (SELECT id FROM fab_nodes WHERE project_plan_id=@plan_id AND node_code='MG_G1_TF');
SET @mg_g1_bf = (SELECT id FROM fab_nodes WHERE project_plan_id=@plan_id AND node_code='MG_G1_BF');
SET @mg_g1_wb = (SELECT id FROM fab_nodes WHERE project_plan_id=@plan_id AND node_code='MG_G1_WB');

SET @ed_web   = (SELECT id FROM fab_nodes WHERE project_plan_id=@plan_id AND node_code='ED_WEB');
SET @ed_tf    = (SELECT id FROM fab_nodes WHERE project_plan_id=@plan_id AND node_code='ED_TF');
SET @bs1      = (SELECT id FROM fab_nodes WHERE project_plan_id=@plan_id AND node_code='BS1');
SET @bs2      = (SELECT id FROM fab_nodes WHERE project_plan_id=@plan_id AND node_code='BS2');
SET @bs3      = (SELECT id FROM fab_nodes WHERE project_plan_id=@plan_id AND node_code='BS3');
SET @pad_pl   = (SELECT id FROM fab_nodes WHERE project_plan_id=@plan_id AND node_code='PAD_PL');
SET @jack_st  = (SELECT id FROM fab_nodes WHERE project_plan_id=@plan_id AND node_code='JACK_STF');

SET @id_web   = (SELECT id FROM fab_nodes WHERE project_plan_id=@plan_id AND node_code='ID_WEB');
SET @id_tf    = (SELECT id FROM fab_nodes WHERE project_plan_id=@plan_id AND node_code='ID_TF');
SET @is1      = (SELECT id FROM fab_nodes WHERE project_plan_id=@plan_id AND node_code='IS1');
SET @is2      = (SELECT id FROM fab_nodes WHERE project_plan_id=@plan_id AND node_code='IS2');
SET @is3      = (SELECT id FROM fab_nodes WHERE project_plan_id=@plan_id AND node_code='IS3');
SET @dcp      = (SELECT id FROM fab_nodes WHERE project_plan_id=@plan_id AND node_code='DCP');
SET @dfp      = (SELECT id FROM fab_nodes WHERE project_plan_id=@plan_id AND node_code='DFP');
SET @dsp      = (SELECT id FROM fab_nodes WHERE project_plan_id=@plan_id AND node_code='DSP');

SET @blb2     = (SELECT id FROM fab_nodes WHERE project_plan_id=@plan_id AND node_code='BLB2');
SET @blb3     = (SELECT id FROM fab_nodes WHERE project_plan_id=@plan_id AND node_code='BLB3');
SET @gus1     = (SELECT id FROM fab_nodes WHERE project_plan_id=@plan_id AND node_code='GUS1');
SET @gus2     = (SELECT id FROM fab_nodes WHERE project_plan_id=@plan_id AND node_code='GUS2');

SET @tf_osp   = (SELECT id FROM fab_nodes WHERE project_plan_id=@plan_id AND node_code='TF_OSP');
SET @tf_isp   = (SELECT id FROM fab_nodes WHERE project_plan_id=@plan_id AND node_code='TF_ISP');
SET @bf_osp   = (SELECT id FROM fab_nodes WHERE project_plan_id=@plan_id AND node_code='BF_OSP');
SET @bf_is1   = (SELECT id FROM fab_nodes WHERE project_plan_id=@plan_id AND node_code='BF_IS1');
SET @bf_is2   = (SELECT id FROM fab_nodes WHERE project_plan_id=@plan_id AND node_code='BF_IS2');
SET @wb_sp    = (SELECT id FROM fab_nodes WHERE project_plan_id=@plan_id AND node_code='WB_SP');


-- ── MG_G2 through MG_G6: same 16-step route as MG_G1 ─────────────────────────
INSERT INTO fab_node_process_routes
  (project_plan_id,node_id,process_step_code,sequence_no,process_name,process_type,machine_or_workcentre_type,estimated_time_value,estimated_time_unit,mandatory,drawing_ref,notes)
VALUES
(@plan_id,@mg_g2,'MG_G2_01',10,'Plate Marking & Nesting','Marking','Marking Table',45,'min',1,'DRG-SCRGTL0071-MG-001','Mark TF, BF, Web plates per nesting plan'),
(@plan_id,@mg_g2,'MG_G2_02',20,'Flange Plate Cutting','Cutting','CNC Plasma / Oxy-Fuel',90,'min',1,'DRG-SCRGTL0071-MG-001','Cut 400×36 TF and 850×45 BF per DXF'),
(@plan_id,@mg_g2,'MG_G2_03',30,'Web Plate Cutting','Cutting','CNC Plasma',60,'min',1,'DRG-SCRGTL0071-MG-001','Cut 1550×16 web'),
(@plan_id,@mg_g2,'MG_G2_04',40,'Flange Straightening','Fit-up','Press / Straightening Bay',30,'min',1,NULL,'Check and correct camber/bow in flanges after cutting'),
(@plan_id,@mg_g2,'MG_G2_05',50,'Sub-Assembly Fit-up','Fit-up','Assembly Bay',120,'min',1,'DRG-SCRGTL0071-MG-001','Tack-weld TF, BF, Web into I-section on jig'),
(@plan_id,@mg_g2,'MG_G2_06',60,'SAW Fillet Welding — Web to Flange','SAW Welding','SAW Welding Machine',240,'min',1,'DRG-SCRGTL0071-MG-001','Submerged arc weld both sides'),
(@plan_id,@mg_g2,'MG_G2_07',70,'Stiffener Fit-up','Fit-up','Assembly Bay',90,'min',1,'DRG-SCRGTL0071-MG-001','Position and tack all stiffeners'),
(@plan_id,@mg_g2,'MG_G2_08',80,'Stiffener MIG Welding','MIG Welding','MIG Welding Station',180,'min',1,'DRG-SCRGTL0071-MG-001','Fillet weld all stiffeners both sides'),
(@plan_id,@mg_g2,'MG_G2_09',90,'Shear Stud Welding','Stud Welding','Stud Welding Gun',120,'min',1,'DRG-SCRGTL0071-MG-001','Weld shear studs to top flange'),
(@plan_id,@mg_g2,'MG_G2_10',100,'Dimensional Check','Inspection','QC Bay / Total Station',60,'min',1,'DRG-SCRGTL0071-MG-001','Check overall length ±3mm, camber, sweep'),
(@plan_id,@mg_g2,'MG_G2_11',110,'Weld Visual Inspection','Inspection','QC Bay',45,'min',1,NULL,'Visual weld inspection per IS 822'),
(@plan_id,@mg_g2,'MG_G2_12',120,'Ultrasonic Testing (UT)','Inspection','UT Equipment',60,'min',1,NULL,'UT on all full penetration butt welds'),
(@plan_id,@mg_g2,'MG_G2_13',130,'Grinding & Repairs','Grinding','Angle Grinder',45,'min',0,NULL,'Repair any UT/visual rejections'),
(@plan_id,@mg_g2,'MG_G2_14',140,'Grit Blasting Sa 2.5','Blasting','Shot Blast Chamber',90,'min',1,NULL,'Blast to Sa 2.5 per IS 9954'),
(@plan_id,@mg_g2,'MG_G2_15',150,'Primer Coat Application','Painting','Paint Bay',60,'min',1,NULL,'Apply 2-coat zinc phosphate primer'),
(@plan_id,@mg_g2,'MG_G2_16',160,'Final Dimensional Inspection','Inspection','QC Bay',30,'min',1,NULL,'Final check against dispatch drawing'),

(@plan_id,@mg_g3,'MG_G3_01',10,'Plate Marking & Nesting','Marking','Marking Table',45,'min',1,'DRG-SCRGTL0071-MG-001','Mark TF, BF, Web plates per nesting plan'),
(@plan_id,@mg_g3,'MG_G3_02',20,'Flange Plate Cutting','Cutting','CNC Plasma / Oxy-Fuel',90,'min',1,'DRG-SCRGTL0071-MG-001','Cut 400×36 TF and 850×45 BF per DXF'),
(@plan_id,@mg_g3,'MG_G3_03',30,'Web Plate Cutting','Cutting','CNC Plasma',60,'min',1,'DRG-SCRGTL0071-MG-001','Cut 1550×16 web'),
(@plan_id,@mg_g3,'MG_G3_04',40,'Flange Straightening','Fit-up','Press / Straightening Bay',30,'min',1,NULL,'Check and correct camber/bow'),
(@plan_id,@mg_g3,'MG_G3_05',50,'Sub-Assembly Fit-up','Fit-up','Assembly Bay',120,'min',1,'DRG-SCRGTL0071-MG-001','Tack-weld TF, BF, Web into I-section'),
(@plan_id,@mg_g3,'MG_G3_06',60,'SAW Fillet Welding — Web to Flange','SAW Welding','SAW Welding Machine',240,'min',1,'DRG-SCRGTL0071-MG-001','Submerged arc weld both sides'),
(@plan_id,@mg_g3,'MG_G3_07',70,'Stiffener Fit-up','Fit-up','Assembly Bay',90,'min',1,'DRG-SCRGTL0071-MG-001','Position and tack all stiffeners'),
(@plan_id,@mg_g3,'MG_G3_08',80,'Stiffener MIG Welding','MIG Welding','MIG Welding Station',180,'min',1,'DRG-SCRGTL0071-MG-001','Fillet weld all stiffeners both sides'),
(@plan_id,@mg_g3,'MG_G3_09',90,'Shear Stud Welding','Stud Welding','Stud Welding Gun',120,'min',1,'DRG-SCRGTL0071-MG-001','Weld shear studs to top flange'),
(@plan_id,@mg_g3,'MG_G3_10',100,'Dimensional Check','Inspection','QC Bay / Total Station',60,'min',1,'DRG-SCRGTL0071-MG-001','Check length ±3mm, camber, sweep'),
(@plan_id,@mg_g3,'MG_G3_11',110,'Weld Visual Inspection','Inspection','QC Bay',45,'min',1,NULL,'Visual weld inspection per IS 822'),
(@plan_id,@mg_g3,'MG_G3_12',120,'Ultrasonic Testing (UT)','Inspection','UT Equipment',60,'min',1,NULL,'UT on all full penetration butt welds'),
(@plan_id,@mg_g3,'MG_G3_13',130,'Grinding & Repairs','Grinding','Angle Grinder',45,'min',0,NULL,'Repair any rejections'),
(@plan_id,@mg_g3,'MG_G3_14',140,'Grit Blasting Sa 2.5','Blasting','Shot Blast Chamber',90,'min',1,NULL,'Blast to Sa 2.5'),
(@plan_id,@mg_g3,'MG_G3_15',150,'Primer Coat Application','Painting','Paint Bay',60,'min',1,NULL,'Apply 2-coat zinc phosphate primer'),
(@plan_id,@mg_g3,'MG_G3_16',160,'Final Dimensional Inspection','Inspection','QC Bay',30,'min',1,NULL,'Final check against dispatch drawing'),

(@plan_id,@mg_g4,'MG_G4_01',10,'Plate Marking & Nesting','Marking','Marking Table',45,'min',1,'DRG-SCRGTL0071-MG-001','Mark TF, BF, Web plates per nesting plan'),
(@plan_id,@mg_g4,'MG_G4_02',20,'Flange Plate Cutting','Cutting','CNC Plasma / Oxy-Fuel',90,'min',1,'DRG-SCRGTL0071-MG-001','Cut 400×36 TF and 850×45 BF per DXF'),
(@plan_id,@mg_g4,'MG_G4_03',30,'Web Plate Cutting','Cutting','CNC Plasma',60,'min',1,'DRG-SCRGTL0071-MG-001','Cut 1550×16 web'),
(@plan_id,@mg_g4,'MG_G4_04',40,'Flange Straightening','Fit-up','Press / Straightening Bay',30,'min',1,NULL,'Check and correct camber/bow'),
(@plan_id,@mg_g4,'MG_G4_05',50,'Sub-Assembly Fit-up','Fit-up','Assembly Bay',120,'min',1,'DRG-SCRGTL0071-MG-001','Tack-weld TF, BF, Web into I-section'),
(@plan_id,@mg_g4,'MG_G4_06',60,'SAW Fillet Welding — Web to Flange','SAW Welding','SAW Welding Machine',240,'min',1,'DRG-SCRGTL0071-MG-001','Submerged arc weld both sides'),
(@plan_id,@mg_g4,'MG_G4_07',70,'Stiffener Fit-up','Fit-up','Assembly Bay',90,'min',1,'DRG-SCRGTL0071-MG-001','Position and tack all stiffeners'),
(@plan_id,@mg_g4,'MG_G4_08',80,'Stiffener MIG Welding','MIG Welding','MIG Welding Station',180,'min',1,'DRG-SCRGTL0071-MG-001','Fillet weld all stiffeners both sides'),
(@plan_id,@mg_g4,'MG_G4_09',90,'Shear Stud Welding','Stud Welding','Stud Welding Gun',120,'min',1,'DRG-SCRGTL0071-MG-001','Weld shear studs to top flange'),
(@plan_id,@mg_g4,'MG_G4_10',100,'Dimensional Check','Inspection','QC Bay / Total Station',60,'min',1,'DRG-SCRGTL0071-MG-001','Check length ±3mm, camber, sweep'),
(@plan_id,@mg_g4,'MG_G4_11',110,'Weld Visual Inspection','Inspection','QC Bay',45,'min',1,NULL,'Visual weld inspection per IS 822'),
(@plan_id,@mg_g4,'MG_G4_12',120,'Ultrasonic Testing (UT)','Inspection','UT Equipment',60,'min',1,NULL,'UT on all butt welds'),
(@plan_id,@mg_g4,'MG_G4_13',130,'Grinding & Repairs','Grinding','Angle Grinder',45,'min',0,NULL,'Repair any rejections'),
(@plan_id,@mg_g4,'MG_G4_14',140,'Grit Blasting Sa 2.5','Blasting','Shot Blast Chamber',90,'min',1,NULL,'Blast to Sa 2.5'),
(@plan_id,@mg_g4,'MG_G4_15',150,'Primer Coat Application','Painting','Paint Bay',60,'min',1,NULL,'Apply 2-coat zinc phosphate primer'),
(@plan_id,@mg_g4,'MG_G4_16',160,'Final Dimensional Inspection','Inspection','QC Bay',30,'min',1,NULL,'Final check'),

(@plan_id,@mg_g5,'MG_G5_01',10,'Plate Marking & Nesting','Marking','Marking Table',45,'min',1,'DRG-SCRGTL0071-MG-001','Mark TF, BF, Web plates'),
(@plan_id,@mg_g5,'MG_G5_02',20,'Flange Plate Cutting','Cutting','CNC Plasma / Oxy-Fuel',90,'min',1,'DRG-SCRGTL0071-MG-001','Cut TF and BF per DXF'),
(@plan_id,@mg_g5,'MG_G5_03',30,'Web Plate Cutting','Cutting','CNC Plasma',60,'min',1,'DRG-SCRGTL0071-MG-001','Cut 1550×16 web'),
(@plan_id,@mg_g5,'MG_G5_04',40,'Flange Straightening','Fit-up','Press / Straightening Bay',30,'min',1,NULL,'Check and correct camber/bow'),
(@plan_id,@mg_g5,'MG_G5_05',50,'Sub-Assembly Fit-up','Fit-up','Assembly Bay',120,'min',1,'DRG-SCRGTL0071-MG-001','Tack-weld TF, BF, Web into I-section'),
(@plan_id,@mg_g5,'MG_G5_06',60,'SAW Fillet Welding — Web to Flange','SAW Welding','SAW Welding Machine',240,'min',1,'DRG-SCRGTL0071-MG-001','Submerged arc weld both sides'),
(@plan_id,@mg_g5,'MG_G5_07',70,'Stiffener Fit-up','Fit-up','Assembly Bay',90,'min',1,'DRG-SCRGTL0071-MG-001','Position and tack all stiffeners'),
(@plan_id,@mg_g5,'MG_G5_08',80,'Stiffener MIG Welding','MIG Welding','MIG Welding Station',180,'min',1,'DRG-SCRGTL0071-MG-001','Fillet weld all stiffeners'),
(@plan_id,@mg_g5,'MG_G5_09',90,'Shear Stud Welding','Stud Welding','Stud Welding Gun',120,'min',1,'DRG-SCRGTL0071-MG-001','Weld shear studs to top flange'),
(@plan_id,@mg_g5,'MG_G5_10',100,'Dimensional Check','Inspection','QC Bay / Total Station',60,'min',1,'DRG-SCRGTL0071-MG-001','Check length, camber, sweep'),
(@plan_id,@mg_g5,'MG_G5_11',110,'Weld Visual Inspection','Inspection','QC Bay',45,'min',1,NULL,'Visual weld inspection'),
(@plan_id,@mg_g5,'MG_G5_12',120,'Ultrasonic Testing (UT)','Inspection','UT Equipment',60,'min',1,NULL,'UT on all butt welds'),
(@plan_id,@mg_g5,'MG_G5_13',130,'Grinding & Repairs','Grinding','Angle Grinder',45,'min',0,NULL,'Repair any rejections'),
(@plan_id,@mg_g5,'MG_G5_14',140,'Grit Blasting Sa 2.5','Blasting','Shot Blast Chamber',90,'min',1,NULL,'Blast to Sa 2.5'),
(@plan_id,@mg_g5,'MG_G5_15',150,'Primer Coat Application','Painting','Paint Bay',60,'min',1,NULL,'Apply primer'),
(@plan_id,@mg_g5,'MG_G5_16',160,'Final Dimensional Inspection','Inspection','QC Bay',30,'min',1,NULL,'Final check'),

(@plan_id,@mg_g6,'MG_G6_01',10,'Plate Marking & Nesting','Marking','Marking Table',45,'min',1,'DRG-SCRGTL0071-MG-001','Mark TF, BF, Web plates'),
(@plan_id,@mg_g6,'MG_G6_02',20,'Flange Plate Cutting','Cutting','CNC Plasma / Oxy-Fuel',90,'min',1,'DRG-SCRGTL0071-MG-001','Cut TF and BF per DXF'),
(@plan_id,@mg_g6,'MG_G6_03',30,'Web Plate Cutting','Cutting','CNC Plasma',60,'min',1,'DRG-SCRGTL0071-MG-001','Cut 1550×16 web'),
(@plan_id,@mg_g6,'MG_G6_04',40,'Flange Straightening','Fit-up','Press / Straightening Bay',30,'min',1,NULL,'Check and correct camber/bow'),
(@plan_id,@mg_g6,'MG_G6_05',50,'Sub-Assembly Fit-up','Fit-up','Assembly Bay',120,'min',1,'DRG-SCRGTL0071-MG-001','Tack-weld TF, BF, Web into I-section'),
(@plan_id,@mg_g6,'MG_G6_06',60,'SAW Fillet Welding — Web to Flange','SAW Welding','SAW Welding Machine',240,'min',1,'DRG-SCRGTL0071-MG-001','Submerged arc weld both sides'),
(@plan_id,@mg_g6,'MG_G6_07',70,'Stiffener Fit-up','Fit-up','Assembly Bay',90,'min',1,'DRG-SCRGTL0071-MG-001','Position and tack all stiffeners'),
(@plan_id,@mg_g6,'MG_G6_08',80,'Stiffener MIG Welding','MIG Welding','MIG Welding Station',180,'min',1,'DRG-SCRGTL0071-MG-001','Fillet weld all stiffeners'),
(@plan_id,@mg_g6,'MG_G6_09',90,'Shear Stud Welding','Stud Welding','Stud Welding Gun',120,'min',1,'DRG-SCRGTL0071-MG-001','Weld shear studs to top flange'),
(@plan_id,@mg_g6,'MG_G6_10',100,'Dimensional Check','Inspection','QC Bay / Total Station',60,'min',1,'DRG-SCRGTL0071-MG-001','Check length, camber, sweep'),
(@plan_id,@mg_g6,'MG_G6_11',110,'Weld Visual Inspection','Inspection','QC Bay',45,'min',1,NULL,'Visual weld inspection'),
(@plan_id,@mg_g6,'MG_G6_12',120,'Ultrasonic Testing (UT)','Inspection','UT Equipment',60,'min',1,NULL,'UT on all butt welds'),
(@plan_id,@mg_g6,'MG_G6_13',130,'Grinding & Repairs','Grinding','Angle Grinder',45,'min',0,NULL,'Repair any rejections'),
(@plan_id,@mg_g6,'MG_G6_14',140,'Grit Blasting Sa 2.5','Blasting','Shot Blast Chamber',90,'min',1,NULL,'Blast to Sa 2.5'),
(@plan_id,@mg_g6,'MG_G6_15',150,'Primer Coat Application','Painting','Paint Bay',60,'min',1,NULL,'Apply primer'),
(@plan_id,@mg_g6,'MG_G6_16',160,'Final Dimensional Inspection','Inspection','QC Bay',30,'min',1,NULL,'Final check');


-- ── G1 Part plates: TF, BF, Web ───────────────────────────────────────────────
INSERT INTO fab_node_process_routes
  (project_plan_id,node_id,process_step_code,sequence_no,process_name,process_type,machine_or_workcentre_type,estimated_time_value,estimated_time_unit,mandatory,drawing_ref,notes)
VALUES
(@plan_id,@mg_g1_tf,'G1_TF_01',10,'Plate Marking','Marking','Marking Table',15,'min',1,'DRG-SCRGTL0071-MG-001','Mark nesting layout on 400×36 flange plate'),
(@plan_id,@mg_g1_tf,'G1_TF_02',20,'CNC Plate Cutting','Cutting','CNC Plasma / Oxy-Fuel',40,'min',1,'DRG-SCRGTL0071-MG-001','Cut to final profile ±1mm tolerance'),
(@plan_id,@mg_g1_tf,'G1_TF_03',30,'Edge Grinding & Dressing','Grinding','Bench Grinder',10,'min',1,NULL,'Dress cut edges; remove burrs and slag'),
(@plan_id,@mg_g1_tf,'G1_TF_04',40,'Dimensional Inspection','Inspection','QC Bay',10,'min',1,'DRG-SCRGTL0071-MG-001','Check length ±1mm, width ±0.5mm, thickness per cert'),

(@plan_id,@mg_g1_bf,'G1_BF_01',10,'Plate Marking','Marking','Marking Table',15,'min',1,'DRG-SCRGTL0071-MG-001','Mark nesting layout on 850×45 flange plate'),
(@plan_id,@mg_g1_bf,'G1_BF_02',20,'CNC Plate Cutting','Cutting','CNC Plasma / Oxy-Fuel',50,'min',1,'DRG-SCRGTL0071-MG-001','Cut to final profile; heavy plate — check kerf'),
(@plan_id,@mg_g1_bf,'G1_BF_03',30,'Edge Grinding & Dressing','Grinding','Bench Grinder',15,'min',1,NULL,'Dress cut edges; check squareness of ends'),
(@plan_id,@mg_g1_bf,'G1_BF_04',40,'Dimensional Inspection','Inspection','QC Bay',10,'min',1,'DRG-SCRGTL0071-MG-001','Check length, width ±0.5mm, thickness against MTC'),

(@plan_id,@mg_g1_wb,'G1_WB_01',10,'Plate Marking','Marking','Marking Table',15,'min',1,'DRG-SCRGTL0071-MG-001','Mark web plate 1550×16 per nesting'),
(@plan_id,@mg_g1_wb,'G1_WB_02',20,'CNC Plasma Cutting','Cutting','CNC Plasma',45,'min',1,'DRG-SCRGTL0071-MG-001','Cut web; leave 80mm bottom edge for weld sequence'),
(@plan_id,@mg_g1_wb,'G1_WB_03',30,'Edge Grinding','Grinding','Bench Grinder',10,'min',1,NULL,'Dress cut edges, remove distortion from plasma'),
(@plan_id,@mg_g1_wb,'G1_WB_04',40,'Dimensional Inspection','Inspection','QC Bay',10,'min',1,'DRG-SCRGTL0071-MG-001','Check height, length ±1mm, flatness');


-- ── ED sub-parts: Web, TF/BF flanges, stiffeners, pad, jack ──────────────────
INSERT INTO fab_node_process_routes
  (project_plan_id,node_id,process_step_code,sequence_no,process_name,process_type,machine_or_workcentre_type,estimated_time_value,estimated_time_unit,mandatory,drawing_ref,notes)
VALUES
(@plan_id,@ed_web,'ED_WEB_01',10,'Plate Marking','Marking','Marking Table',10,'min',1,'DRG-SCRGTL0071-ED-001','Mark 1275×12 web plate'),
(@plan_id,@ed_web,'ED_WEB_02',20,'CNC Plasma Cutting','Cutting','CNC Plasma',25,'min',1,'DRG-SCRGTL0071-ED-001','Cut web plate to size'),
(@plan_id,@ed_web,'ED_WEB_03',30,'Edge Dressing','Grinding','Bench Grinder',8,'min',1,NULL,'Dress cut edges'),
(@plan_id,@ed_web,'ED_WEB_04',40,'Part Inspection','Inspection','QC Bay',8,'min',1,'DRG-SCRGTL0071-ED-001','Check dims ±1mm'),

(@plan_id,@ed_tf,'ED_TF_01',10,'Plate Marking','Marking','Marking Table',10,'min',1,'DRG-SCRGTL0071-ED-001','Mark top & bottom flange plates 200×12'),
(@plan_id,@ed_tf,'ED_TF_02',20,'CNC Plasma Cutting','Cutting','CNC Plasma',20,'min',1,'DRG-SCRGTL0071-ED-001','Cut both flanges per DXF'),
(@plan_id,@ed_tf,'ED_TF_03',30,'Edge Dressing','Grinding','Bench Grinder',8,'min',1,NULL,'Dress cut edges'),
(@plan_id,@ed_tf,'ED_TF_04',40,'Part Inspection','Inspection','QC Bay',5,'min',1,'DRG-SCRGTL0071-ED-001','Check length, width ±0.5mm'),

(@plan_id,@bs1,'BS1_01',10,'Plate Cutting','Cutting','Bandsaw / Plasma',12,'min',1,'DRG-SCRGTL0071-ED-001','Cut 1550×190×20 plate for BS1'),
(@plan_id,@bs1,'BS1_02',20,'Edge Dressing','Grinding','Bench Grinder',5,'min',1,NULL,'Dress all edges, remove burrs'),
(@plan_id,@bs1,'BS1_03',30,'Part Inspection','Inspection','QC Bay',5,'min',1,'DRG-SCRGTL0071-ED-001','Check dims, fit-check against web'),

(@plan_id,@bs2,'BS2_01',10,'Plate Cutting','Cutting','Bandsaw / Plasma',12,'min',1,'DRG-SCRGTL0071-ED-001','Cut 1550×190×20 plate for BS2'),
(@plan_id,@bs2,'BS2_02',20,'Hole Drilling (if req)','Drilling','Radial Drill',10,'min',0,'DRG-SCRGTL0071-ED-001','Drill lifting/erection holes if specified'),
(@plan_id,@bs2,'BS2_03',30,'Edge Dressing','Grinding','Bench Grinder',5,'min',1,NULL,'Dress all edges, remove burrs'),
(@plan_id,@bs2,'BS2_04',40,'Part Inspection','Inspection','QC Bay',5,'min',1,'DRG-SCRGTL0071-ED-001','Check dims, bearing contact face flatness'),

(@plan_id,@bs3,'BS3_01',10,'Plate Cutting','Cutting','Bandsaw / Plasma',12,'min',1,'DRG-SCRGTL0071-ED-001','Cut 1550×190×20 plate for BS3'),
(@plan_id,@bs3,'BS3_02',20,'Hole Drilling (if req)','Drilling','Radial Drill',10,'min',0,'DRG-SCRGTL0071-ED-001','Drill lifting/erection holes if specified'),
(@plan_id,@bs3,'BS3_03',30,'Edge Dressing','Grinding','Bench Grinder',5,'min',1,NULL,'Dress all edges'),
(@plan_id,@bs3,'BS3_04',40,'Part Inspection','Inspection','QC Bay',5,'min',1,'DRG-SCRGTL0071-ED-001','Check dims and bearing contact flatness'),

(@plan_id,@pad_pl,'PP_01',10,'Plate Cutting','Cutting','Bandsaw',5,'min',1,'DRG-SCRGTL0071-ED-001','Cut 180×100×20 pad plates'),
(@plan_id,@pad_pl,'PP_02',20,'Milling/Grinding (top face)','Grinding','Surface Grinder',8,'min',1,'DRG-SCRGTL0071-ED-001','Machine bearing face flat to ±0.2mm'),
(@plan_id,@pad_pl,'PP_03',30,'Part Inspection','Inspection','QC Bay',3,'min',1,'DRG-SCRGTL0071-ED-001','Check flatness, dims'),

(@plan_id,@jack_st,'JS_01',10,'Plate Cutting','Cutting','Bandsaw / Plasma',8,'min',1,'DRG-SCRGTL0071-ED-001','Cut 1275×90×12 jack stiffener plates'),
(@plan_id,@jack_st,'JS_02',20,'Edge Dressing','Grinding','Bench Grinder',5,'min',1,NULL,'Dress cut edges'),
(@plan_id,@jack_st,'JS_03',30,'Part Inspection','Inspection','QC Bay',3,'min',1,'DRG-SCRGTL0071-ED-001','Check dims ±1mm');


-- ── ID sub-parts ──────────────────────────────────────────────────────────────
INSERT INTO fab_node_process_routes
  (project_plan_id,node_id,process_step_code,sequence_no,process_name,process_type,machine_or_workcentre_type,estimated_time_value,estimated_time_unit,mandatory,drawing_ref,notes)
VALUES
(@plan_id,@id_web,'ID_WEB_01',10,'Plate Marking','Marking','Marking Table',10,'min',1,'DRG-SCRGTL0071-ID-001','Mark 1275×12 ID web plate'),
(@plan_id,@id_web,'ID_WEB_02',20,'CNC Plasma Cutting','Cutting','CNC Plasma',25,'min',1,'DRG-SCRGTL0071-ID-001','Cut web to size'),
(@plan_id,@id_web,'ID_WEB_03',30,'Edge Dressing','Grinding','Bench Grinder',8,'min',1,NULL,'Dress cut edges'),
(@plan_id,@id_web,'ID_WEB_04',40,'Part Inspection','Inspection','QC Bay',5,'min',1,'DRG-SCRGTL0071-ID-001','Check dims ±1mm'),

(@plan_id,@id_tf,'ID_TF_01',10,'Plate Marking','Marking','Marking Table',8,'min',1,'DRG-SCRGTL0071-ID-001','Mark 200×12 flange plates'),
(@plan_id,@id_tf,'ID_TF_02',20,'CNC Plasma Cutting','Cutting','CNC Plasma',18,'min',1,'DRG-SCRGTL0071-ID-001','Cut top and bottom flanges'),
(@plan_id,@id_tf,'ID_TF_03',30,'Edge Dressing','Grinding','Bench Grinder',6,'min',1,NULL,'Dress cut edges'),
(@plan_id,@id_tf,'ID_TF_04',40,'Part Inspection','Inspection','QC Bay',5,'min',1,'DRG-SCRGTL0071-ID-001','Check dims ±0.5mm'),

(@plan_id,@is1,'IS1_01',10,'Plate Cutting','Cutting','Bandsaw',8,'min',1,'DRG-SCRGTL0071-ID-001','Cut 1550×160×12 IS1 plates'),
(@plan_id,@is1,'IS1_02',20,'Edge Dressing','Grinding','Bench Grinder',4,'min',1,NULL,'Remove burrs from all edges'),
(@plan_id,@is1,'IS1_03',30,'Part Inspection','Inspection','QC Bay',3,'min',1,'DRG-SCRGTL0071-ID-001','Check dims, fit-check against web'),

(@plan_id,@is2,'IS2_01',10,'Plate Cutting','Cutting','Bandsaw',8,'min',1,'DRG-SCRGTL0071-ID-001','Cut 1550×160×12 IS2 plates'),
(@plan_id,@is2,'IS2_02',20,'Edge Dressing','Grinding','Bench Grinder',4,'min',1,NULL,'Remove burrs'),
(@plan_id,@is2,'IS2_03',30,'Part Inspection','Inspection','QC Bay',3,'min',1,'DRG-SCRGTL0071-ID-001','Check dims'),

(@plan_id,@is3,'IS3_01',10,'Plate Cutting','Cutting','Bandsaw',8,'min',1,'DRG-SCRGTL0071-ID-001','Cut 1550×160×12 IS3 plates'),
(@plan_id,@is3,'IS3_02',20,'Edge Dressing','Grinding','Bench Grinder',4,'min',1,NULL,'Remove burrs'),
(@plan_id,@is3,'IS3_03',30,'Part Inspection','Inspection','QC Bay',3,'min',1,'DRG-SCRGTL0071-ID-001','Check dims'),

(@plan_id,@dcp,'DCP_01',10,'CNC Cutting','Cutting','CNC Plasma',5,'min',1,'DRG-SCRGTL0071-ID-001','Cut 106×80×12 corner plate including cope cut'),
(@plan_id,@dcp,'DCP_02',20,'Edge Dressing','Grinding','Bench Grinder',3,'min',1,NULL,'Remove burrs and slag'),
(@plan_id,@dcp,'DCP_03',30,'Part Inspection','Inspection','QC Bay',2,'min',1,'DRG-SCRGTL0071-ID-001','Check profile and cope geometry'),

(@plan_id,@dfp,'DFP_01',10,'CNC Cutting','Cutting','CNC Plasma',8,'min',1,'DRG-SCRGTL0071-ID-001','Cut 1828×80×12 flange plates'),
(@plan_id,@dfp,'DFP_02',20,'Edge Dressing','Grinding','Bench Grinder',4,'min',1,NULL,'Remove burrs'),
(@plan_id,@dfp,'DFP_03',30,'Part Inspection','Inspection','QC Bay',3,'min',1,'DRG-SCRGTL0071-ID-001','Check length ±1mm, width ±0.5mm'),

(@plan_id,@dsp,'DSP_01',10,'CNC Cutting','Cutting','CNC Plasma',6,'min',1,'DRG-SCRGTL0071-ID-001','Cut 825×80×12 side plates'),
(@plan_id,@dsp,'DSP_02',20,'Edge Dressing','Grinding','Bench Grinder',3,'min',1,NULL,'Remove burrs'),
(@plan_id,@dsp,'DSP_03',30,'Part Inspection','Inspection','QC Bay',3,'min',1,'DRG-SCRGTL0071-ID-001','Check dims');


-- ── BLB2, BLB3 (same route as BLB1, different lengths) ───────────────────────
INSERT INTO fab_node_process_routes
  (project_plan_id,node_id,process_step_code,sequence_no,parallel_group,process_name,process_type,machine_or_workcentre_type,estimated_time_value,estimated_time_unit,mandatory,drawing_ref,notes)
VALUES
(@plan_id,@blb2,'BLB2_01',10,NULL,'SHS Cutting to Length','Cutting','Bandsaw / CNC Plasma',20,'min',1,'DRG-SCRGTL0071-BL-001','Cut 130×130×10 SHS to 2252mm ±1mm'),
(@plan_id,@blb2,'BLB2_02',20,'P1','End Drilling','Drilling','Radial Drill',15,'min',1,'DRG-SCRGTL0071-BL-001','Drill bolt holes per BLB hole spacing (14° skew)'),
(@plan_id,@blb2,'BLB2_03',20,'P1','Deburring & Edge Dressing','Grinding','Grinding Station',10,'min',1,NULL,'Deburr all holes; dress cut ends'),
(@plan_id,@blb2,'BLB2_04',30,NULL,'Gusset Fit & Tack','Fit-up','Assembly Bay',25,'min',1,'DRG-SCRGTL0071-BL-001','Tack GUS2 gusset plates at correct skew angle'),
(@plan_id,@blb2,'BLB2_05',40,NULL,'Gusset Fillet Welding','MIG Welding','MIG Welding Station',30,'min',1,'DRG-SCRGTL0071-BL-001','Weld gusset to SHS, 8mm fillet full perimeter'),
(@plan_id,@blb2,'BLB2_06',50,NULL,'Part QC Inspection','Inspection','QC Bay',10,'min',1,NULL,'Check dimensions, hole positions, weld quality'),

(@plan_id,@blb3,'BLB3_01',10,NULL,'SHS Cutting to Length','Cutting','Bandsaw / CNC Plasma',18,'min',1,'DRG-SCRGTL0071-BL-001','Cut 130×130×10 SHS to 1607mm ±1mm'),
(@plan_id,@blb3,'BLB3_02',20,'P1','End Drilling','Drilling','Radial Drill',15,'min',1,'DRG-SCRGTL0071-BL-001','Drill bolt holes per BLB hole spacing (14° skew)'),
(@plan_id,@blb3,'BLB3_03',20,'P1','Deburring & Edge Dressing','Grinding','Grinding Station',10,'min',1,NULL,'Deburr all holes; dress cut ends'),
(@plan_id,@blb3,'BLB3_04',30,NULL,'Gusset Fit & Tack','Fit-up','Assembly Bay',20,'min',1,'DRG-SCRGTL0071-BL-001','Tack GUS1 gusset plates at correct skew angle'),
(@plan_id,@blb3,'BLB3_05',40,NULL,'Gusset Fillet Welding','MIG Welding','MIG Welding Station',25,'min',1,'DRG-SCRGTL0071-BL-001','Weld gusset to SHS, 8mm fillet'),
(@plan_id,@blb3,'BLB3_06',50,NULL,'Part QC Inspection','Inspection','QC Bay',10,'min',1,NULL,'Check dimensions, hole positions, weld quality');


-- ── Gusset Plates GUS1, GUS2 ─────────────────────────────────────────────────
INSERT INTO fab_node_process_routes
  (project_plan_id,node_id,process_step_code,sequence_no,process_name,process_type,machine_or_workcentre_type,estimated_time_value,estimated_time_unit,mandatory,drawing_ref,notes)
VALUES
(@plan_id,@gus1,'GUS1_01',10,'CNC Plate Cutting','Cutting','CNC Plasma',10,'min',1,'DRG-SCRGTL0071-BL-001','Cut 475×150×16 gusset with 14° skew profile'),
(@plan_id,@gus1,'GUS1_02',20,'CNC Drilling','Drilling','CNC Drill',15,'min',1,'DRG-SCRGTL0071-BL-001','Drill bolt holes ±0.3mm tolerance'),
(@plan_id,@gus1,'GUS1_03',30,'Edge Dressing & Deburr','Grinding','Grinding Station',5,'min',1,NULL,'Dress all edges; deburr holes'),
(@plan_id,@gus1,'GUS1_04',40,'Part QC','Inspection','QC Bay',5,'min',1,'DRG-SCRGTL0071-BL-001','Check hole positions, skew profile, edge distances'),

(@plan_id,@gus2,'GUS2_01',10,'CNC Plate Cutting','Cutting','CNC Plasma',10,'min',1,'DRG-SCRGTL0071-BL-001','Cut 550×150×16 gusset with 14° skew profile'),
(@plan_id,@gus2,'GUS2_02',20,'CNC Drilling','Drilling','CNC Drill',15,'min',1,'DRG-SCRGTL0071-BL-001','Drill bolt holes ±0.3mm tolerance'),
(@plan_id,@gus2,'GUS2_03',30,'Edge Dressing & Deburr','Grinding','Grinding Station',5,'min',1,NULL,'Dress all edges; deburr holes'),
(@plan_id,@gus2,'GUS2_04',40,'Part QC','Inspection','QC Bay',5,'min',1,'DRG-SCRGTL0071-BL-001','Check hole positions, skew profile, edge distances');


-- ── Splice Plates (TF_OSP, TF_ISP, BF_OSP, BF_IS1, BF_IS2) ─────────────────
INSERT INTO fab_node_process_routes
  (project_plan_id,node_id,process_step_code,sequence_no,process_name,process_type,machine_or_workcentre_type,estimated_time_value,estimated_time_unit,mandatory,drawing_ref,notes)
VALUES
(@plan_id,@tf_osp,'TFOSP_01',10,'Plate Cutting','Cutting','CNC Plasma',15,'min',1,'DRG-SCRGTL0071-SP-001','Cut 930×400×20 top flange outer splice plate'),
(@plan_id,@tf_osp,'TFOSP_02',20,'CNC Drilling','Drilling','CNC Drill',25,'min',1,'DRG-SCRGTL0071-SP-001','Drill bolt pattern per splice detail — 8.8 HT bolts'),
(@plan_id,@tf_osp,'TFOSP_03',30,'Deburr & Stamp','Grinding','Grinder',8,'min',1,NULL,'Deburr holes; stamp part number'),
(@plan_id,@tf_osp,'TFOSP_04',40,'Part QC','Inspection','QC Bay',10,'min',1,'DRG-SCRGTL0071-SP-001','Check hole pos ±0.5mm, edge distances, flatness'),

(@plan_id,@tf_isp,'TFISP_01',10,'Plate Cutting','Cutting','CNC Plasma',12,'min',1,'DRG-SCRGTL0071-SP-001','Cut 930×180×20 inner splice plate'),
(@plan_id,@tf_isp,'TFISP_02',20,'CNC Drilling','Drilling','CNC Drill',20,'min',1,'DRG-SCRGTL0071-SP-001','Drill bolt pattern matching outer plate'),
(@plan_id,@tf_isp,'TFISP_03',30,'Deburr & Stamp','Grinding','Grinder',6,'min',1,NULL,'Deburr holes; stamp part number'),
(@plan_id,@tf_isp,'TFISP_04',40,'Part QC','Inspection','QC Bay',8,'min',1,'DRG-SCRGTL0071-SP-001','Check hole positions ±0.5mm'),

(@plan_id,@bf_osp,'BFOSP_01',10,'Plate Cutting','Cutting','CNC Plasma',18,'min',1,'DRG-SCRGTL0071-SP-001','Cut 880×850×36 heavy bottom flange outer splice plate'),
(@plan_id,@bf_osp,'BFOSP_02',20,'CNC Drilling','Drilling','CNC Drill',30,'min',1,'DRG-SCRGTL0071-SP-001','Drill bolt pattern — heavy plate, check drill speed'),
(@plan_id,@bf_osp,'BFOSP_03',30,'Deburr & Stamp','Grinding','Grinder',10,'min',1,NULL,'Deburr all holes; stamp mark number'),
(@plan_id,@bf_osp,'BFOSP_04',40,'Part QC','Inspection','QC Bay',10,'min',1,'DRG-SCRGTL0071-SP-001','Check hole pos ±0.5mm, flatness of bearing face'),

(@plan_id,@bf_is1,'BFIS1_01',10,'Plate Cutting','Cutting','CNC Plasma',15,'min',1,'DRG-SCRGTL0071-SP-001','Cut 880×400×36 inner filler plate Type 1'),
(@plan_id,@bf_is1,'BFIS1_02',20,'CNC Drilling','Drilling','CNC Drill',25,'min',1,'DRG-SCRGTL0071-SP-001','Drill bolt pattern matching outer plate'),
(@plan_id,@bf_is1,'BFIS1_03',30,'Deburr & Stamp','Grinding','Grinder',8,'min',1,NULL,'Deburr holes; stamp mark'),
(@plan_id,@bf_is1,'BFIS1_04',40,'Part QC','Inspection','QC Bay',8,'min',1,'DRG-SCRGTL0071-SP-001','Check hole positions ±0.5mm'),

(@plan_id,@bf_is2,'BFIS2_01',10,'Plate Cutting','Cutting','CNC Plasma',15,'min',1,'DRG-SCRGTL0071-SP-001','Cut 880×725×36 inner filler plate Type 2'),
(@plan_id,@bf_is2,'BFIS2_02',20,'CNC Drilling','Drilling','CNC Drill',25,'min',1,'DRG-SCRGTL0071-SP-001','Drill bolt pattern matching outer plate'),
(@plan_id,@bf_is2,'BFIS2_03',30,'Deburr & Stamp','Grinding','Grinder',8,'min',1,NULL,'Deburr holes; stamp mark'),
(@plan_id,@bf_is2,'BFIS2_04',40,'Part QC','Inspection','QC Bay',8,'min',1,'DRG-SCRGTL0071-SP-001','Check hole positions ±0.5mm');


-- ── Verification ─────────────────────────────────────────────────────────────
SELECT n.node_code, COUNT(r.id) AS routes
FROM fab_nodes n
LEFT JOIN fab_node_process_routes r ON r.node_id = n.id AND r.deleted_at IS NULL
WHERE n.project_plan_id = @plan_id AND n.deleted_at IS NULL
GROUP BY n.id, n.node_code
ORDER BY n.id;
