-- Mediums exactly as listed in the SEBA catalogue's medium filter, plus those that
-- appear only in table rows (Garo, Sanskrit, Santhali) and the catalogue's "All".
-- ocr_lang values are tesseract packs; only eng/asm/ben/hin are installed by default
-- (install tesseract-ocr-<code> for others, otherwise OCR falls back to eng).
INSERT INTO languages (code, name, ocr_lang) VALUES
  ('all',      'All mediums', 'eng'),
  ('assamese', 'Assamese',    'asm+eng'),
  ('bengali',  'Bengali',     'ben+eng'),
  ('bodo',     'Bodo',        'hin+eng'),
  ('english',  'English',     'eng'),
  ('garo',     'Garo',        'eng'),
  ('hindi',    'Hindi',       'hin+eng'),
  ('karbi',    'Karbi',       'eng'),
  ('manipuri', 'Manipuri',    'ben+eng'),
  ('nepali',   'Nepali',      'hin+eng'),
  ('sanskrit', 'Sanskrit',    'hin+eng'),
  ('santhali', 'Santhali',    'eng')
ON CONFLICT (code) DO NOTHING;
