-- FabFlow: Seed fab_process_type_registry with all 24 generic process types
-- Provides sensible default metric_key + rate per type. Override per company as needed.
-- Safe to re-run: ON DUPLICATE KEY UPDATE keeps existing rows fresh.

SET @company_id = COALESCE(@company_id, 1);  -- override before sourcing if needed

INSERT INTO fab_process_type_registry
  (company_id, process_type_name, description, metric_key, rate_value, rate_unit, active)
VALUES
  (@company_id, 'Cutting',              'Plasma / oxy / saw cutting',          'cut_length_mm',    0.002,  'hr/mm',     1),
  (@company_id, 'Profiling',            'CNC profiling',                       'cut_length_mm',    0.0025, 'hr/mm',     1),
  (@company_id, 'Marking',              'Layout marking',                      'length_mm',        0.0005, 'hr/mm',     1),
  (@company_id, 'Drilling',             'Drill holes',                         'num_holes',        0.05,   'hr/hole',   1),
  (@company_id, 'Forming',              'Forming / rolling',                   'length_mm',        0.001,  'hr/mm',     1),
  (@company_id, 'Bending',              'Press brake bending',                 'bend_length_mm',   0.0015, 'hr/mm',     1),
  (@company_id, 'Fitting',              'Component fit-up',                    'length_mm',        0.001,  'hr/mm',     1),
  (@company_id, 'Fit-Up',               'Pre-weld fit-up',                     'length_mm',        0.0012, 'hr/mm',     1),
  (@company_id, 'Tack Welding',         'Tack welds before full weld',         'weld_length_mm',   0.005,  'hr/mm',     1),
  (@company_id, 'Welding',              'General welding',                     'weld_length_mm',   0.02,   'hr/mm',     1),
  (@company_id, 'MIG Welding',          'MIG / GMAW welding',                  'weld_length_mm',   0.015,  'hr/mm',     1),
  (@company_id, 'SAW Welding',          'Submerged arc welding',               'weld_length_mm',   0.012,  'hr/mm',     1),
  (@company_id, 'Stud Welding',         'Stud welding',                        'num_studs',        0.04,   'hr/stud',   1),
  (@company_id, 'FCAW Welding',         'Flux-cored arc welding',              'weld_length_mm',   0.018,  'hr/mm',     1),
  (@company_id, 'Grinding',             'Surface grinding',                    'grind_length_mm',  0.003,  'hr/mm',     1),
  (@company_id, 'Back Gouging',         'Back gouging before re-weld',         'weld_length_mm',   0.004,  'hr/mm',     1),
  (@company_id, 'Inspection',           'Visual / dimensional inspection',     'length_mm',        0.0003, 'hr/mm',     1),
  (@company_id, 'NDE',                  'Non-destructive examination',         'weld_length_mm',   0.001,  'hr/mm',     1),
  (@company_id, 'Blasting',             'Shot / grit blasting',                'blast_area_m2',    0.5,    'hr/m2',     1),
  (@company_id, 'Surface Preparation',  'Surface prep before coating',         'blast_area_m2',    0.4,    'hr/m2',     1),
  (@company_id, 'Painting',             'Paint coating',                       'paint_area_m2',    0.3,    'hr/m2',     1),
  (@company_id, 'Assembly',             'Assembly of subcomponents',           'mass_kg',          0.05,   'hr/kg',     1),
  (@company_id, 'Dispatch',             'Pack and dispatch',                   'mass_kg',          0.005,  'hr/kg',     1),
  (@company_id, 'Other',                'Generic catch-all',                   NULL,                NULL,   NULL,        1)
ON DUPLICATE KEY UPDATE
  description = VALUES(description),
  metric_key  = COALESCE(fab_process_type_registry.metric_key, VALUES(metric_key)),
  rate_value  = COALESCE(fab_process_type_registry.rate_value, VALUES(rate_value)),
  rate_unit   = COALESCE(fab_process_type_registry.rate_unit,  VALUES(rate_unit)),
  active      = VALUES(active);

SELECT process_type_name, metric_key, rate_value, rate_unit
FROM fab_process_type_registry
WHERE company_id = @company_id
ORDER BY process_type_name;
