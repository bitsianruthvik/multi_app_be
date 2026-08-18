-- fab_units seed data (2026-08-18)
-- Run: source this file with the mysql CLI after the fab_units DDL exists.
-- Safe to re-run: every row is an upsert on the code primary key.
--
-- WHY A FACTOR AT ALL. services/fieldVocabulary.js declares units but converts
-- nothing, so a length authored in metres against a formula that assumes
-- millimetres is wrong by 1000x and still looks plausible. One number per unit
-- closes that hole without a conversion library:
--     value_in_base = value * factor_to_base
-- and two values are only comparable when their rows share a base_code. A
-- caller that sees two different base_code values must refuse, not guess.
--
-- WHY SOME UNITS ARE THEIR OWN BASE. Money, the rate group and the electrical
-- group have no factor that is true at all times:
--   money       INR to USD needs an exchange rate that moves daily. Freezing
--               one into seed data would silently backdate every costing that
--               ever reads it, so no rate is stored here at all.
--   rates       mm/min and kg/min measure different things, and INR/kg carries
--               money inside it. Each is comparable only against itself.
--   electrical  kW to kVA needs the power factor of the real load, and A / V
--               are not power in the first place.
-- These still get a row, with factor_to_base = 1 and base_code = code, so that
-- "this unit does not convert" is an explicit answer from the table rather than
-- a missing row a caller has to interpret.
--
-- ASCII ONLY. The deploy pipes this file through the mysql client without
-- --default-character-set, so a non-ASCII byte lands in production as mojibake.
-- That is why area reads m2 and volume reads m3 rather than the squared and
-- cubed glyphs, here and in the comments.

-- ===== LENGTH (base: m) =====
-- Metre and not millimetre as the base: mm would turn every imperial factor
-- into a large number, and the shop floor quotes both systems.
INSERT INTO fab_units (code, dimension, base_code, factor_to_base, label) VALUES
  ('mm',   'length', 'm', 0.001000000000, 'Millimetre'),
  ('cm',   'length', 'm', 0.010000000000, 'Centimetre'),
  ('m',    'length', 'm', 1.000000000000, 'Metre'),
  ('inch', 'length', 'm', 0.025400000000, 'Inch'),
  ('ft',   'length', 'm', 0.304800000000, 'Foot')
ON DUPLICATE KEY UPDATE dimension=VALUES(dimension), base_code=VALUES(base_code), factor_to_base=VALUES(factor_to_base), label=VALUES(label);

-- ===== AREA (base: m2) =====
-- sqft is the square of the exact 0.3048 m foot, so 0.09290304 is exact rather
-- than a rounded figure.
INSERT INTO fab_units (code, dimension, base_code, factor_to_base, label) VALUES
  ('mm2',  'area', 'm2', 0.000001000000, 'Square millimetre'),
  ('cm2',  'area', 'm2', 0.000100000000, 'Square centimetre'),
  ('m2',   'area', 'm2', 1.000000000000, 'Square metre'),
  ('sqft', 'area', 'm2', 0.092903040000, 'Square foot')
ON DUPLICATE KEY UPDATE dimension=VALUES(dimension), base_code=VALUES(base_code), factor_to_base=VALUES(factor_to_base), label=VALUES(label);

-- ===== VOLUME (base: m3) =====
-- litre is volume and not a dimension of its own: 1 litre is exactly 1 dm3.
INSERT INTO fab_units (code, dimension, base_code, factor_to_base, label) VALUES
  ('mm3',   'volume', 'm3', 0.000000001000, 'Cubic millimetre'),
  ('cm3',   'volume', 'm3', 0.000001000000, 'Cubic centimetre'),
  ('m3',    'volume', 'm3', 1.000000000000, 'Cubic metre'),
  ('litre', 'volume', 'm3', 0.001000000000, 'Litre')
ON DUPLICATE KEY UPDATE dimension=VALUES(dimension), base_code=VALUES(base_code), factor_to_base=VALUES(factor_to_base), label=VALUES(label);

-- ===== MASS (base: kg) =====
-- tonne is the metric tonne of 1000 kg, the only tonne steel is quoted in here;
-- a short or long ton would be a different code. lb is the international
-- avoirdupois pound, which is exact by definition and not a measured value.
INSERT INTO fab_units (code, dimension, base_code, factor_to_base, label) VALUES
  ('g',     'mass', 'kg', 0.001000000000, 'Gram'),
  ('kg',    'mass', 'kg', 1.000000000000, 'Kilogram'),
  ('tonne', 'mass', 'kg', 1000.000000000000, 'Tonne (metric, 1000 kg)'),
  ('lb',    'mass', 'kg', 0.453592370000, 'Pound')
ON DUPLICATE KEY UPDATE dimension=VALUES(dimension), base_code=VALUES(base_code), factor_to_base=VALUES(factor_to_base), label=VALUES(label);

-- ===== TIME (base: sec) =====
-- Second and not hour, so every factor is a whole number and a cycle time in
-- seconds converts without a repeating decimal.
-- years is a NOMINAL 365 days. A Julian 365.25-day year would surprise anyone
-- reading a warranty or depreciation field, and leap-day exactness is not what
-- those fields are measuring.
INSERT INTO fab_units (code, dimension, base_code, factor_to_base, label) VALUES
  ('sec',   'time', 'sec', 1.000000000000, 'Second'),
  ('min',   'time', 'sec', 60.000000000000, 'Minute'),
  ('hrs',   'time', 'sec', 3600.000000000000, 'Hour'),
  ('days',  'time', 'sec', 86400.000000000000, 'Day'),
  ('years', 'time', 'sec', 31536000.000000000000, 'Year (nominal, 365 days)')
ON DUPLICATE KEY UPDATE dimension=VALUES(dimension), base_code=VALUES(base_code), factor_to_base=VALUES(factor_to_base), label=VALUES(label);

-- ===== COUNT (base: nos) =====
-- Dimensionless, so every factor is 1 and the base is only nominal.
-- Deliberately NOT pairs = 2 nos and NOT sets = n nos: a pair of bearings is one
-- issued line, and a set has no fixed member count, so multiplying either out
-- would inflate stock the moment somebody converted it.
INSERT INTO fab_units (code, dimension, base_code, factor_to_base, label) VALUES
  ('nos',   'count', 'nos', 1.000000000000, 'Numbers'),
  ('pcs',   'count', 'nos', 1.000000000000, 'Pieces'),
  ('sets',  'count', 'nos', 1.000000000000, 'Sets'),
  ('pairs', 'count', 'nos', 1.000000000000, 'Pairs')
ON DUPLICATE KEY UPDATE dimension=VALUES(dimension), base_code=VALUES(base_code), factor_to_base=VALUES(factor_to_base), label=VALUES(label);

-- ===== RATIO (base: ratio) =====
-- The one self-based group that DOES convert: percent is exactly 1/100 of a
-- bare ratio. Storing 0.01 here is what stops a 5 percent scrap allowance being
-- read as 5x by a formula that expects a fraction.
INSERT INTO fab_units (code, dimension, base_code, factor_to_base, label) VALUES
  ('%',     'ratio', 'ratio', 0.010000000000, 'Percent'),
  ('ratio', 'ratio', 'ratio', 1.000000000000, 'Ratio (fraction)')
ON DUPLICATE KEY UPDATE dimension=VALUES(dimension), base_code=VALUES(base_code), factor_to_base=VALUES(factor_to_base), label=VALUES(label);

-- ===== RATE (self-based, see header) =====
-- Each rate is its own base. Converting mm/min to m/min is arithmetically easy
-- but is NOT modelled here, because this table carries one factor per row and a
-- compound unit needs a factor per component. Until that exists, a rate is
-- comparable only against a rate with the same code.
INSERT INTO fab_units (code, dimension, base_code, factor_to_base, label) VALUES
  ('mm/min',  'rate', 'mm/min',  1.000000000000, 'Millimetres per minute'),
  ('m/min',   'rate', 'm/min',   1.000000000000, 'Metres per minute'),
  ('kg/min',  'rate', 'kg/min',  1.000000000000, 'Kilograms per minute'),
  ('kg/m3',   'rate', 'kg/m3',   1.000000000000, 'Kilograms per cubic metre'),
  ('nos/min', 'rate', 'nos/min', 1.000000000000, 'Numbers per minute'),
  ('INR/kg',  'rate', 'INR/kg',  1.000000000000, 'Rupees per kilogram')
ON DUPLICATE KEY UPDATE dimension=VALUES(dimension), base_code=VALUES(base_code), factor_to_base=VALUES(factor_to_base), label=VALUES(label);

-- ===== MONEY (self-based, see header) =====
-- No currency converts without an exchange rate, and an exchange rate is a
-- dated fact rather than seed data. Each currency is therefore its own base, so
-- a cross-currency comparison fails loudly instead of quietly applying a rate
-- that was true on the day this file was written.
INSERT INTO fab_units (code, dimension, base_code, factor_to_base, label) VALUES
  ('INR', 'money', 'INR', 1.000000000000, 'Indian Rupee'),
  ('USD', 'money', 'USD', 1.000000000000, 'US Dollar'),
  ('EUR', 'money', 'EUR', 1.000000000000, 'Euro')
ON DUPLICATE KEY UPDATE dimension=VALUES(dimension), base_code=VALUES(base_code), factor_to_base=VALUES(factor_to_base), label=VALUES(label);

-- ===== ELECTRICAL (self-based, see header) =====
-- Four different physical quantities that the picker groups together for the
-- user, not one dimension. kW is real power, kVA is apparent power, and the
-- ratio between them is the power factor of the load being measured rather than
-- a constant. A is current and V is voltage. Nothing here converts to anything
-- else here, which is why the group name is the dimension and the base is the
-- unit itself.
INSERT INTO fab_units (code, dimension, base_code, factor_to_base, label) VALUES
  ('kW',  'electrical', 'kW',  1.000000000000, 'Kilowatt (real power)'),
  ('kVA', 'electrical', 'kVA', 1.000000000000, 'Kilovolt-ampere (apparent power)'),
  ('A',   'electrical', 'A',   1.000000000000, 'Ampere'),
  ('V',   'electrical', 'V',   1.000000000000, 'Volt')
ON DUPLICATE KEY UPDATE dimension=VALUES(dimension), base_code=VALUES(base_code), factor_to_base=VALUES(factor_to_base), label=VALUES(label);
