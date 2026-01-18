# Dynamic Document Retrieval Implementation - Complete

## Summary

Successfully replaced the hardcoded `FACTSHEET` in `analysis_service.py` with a **dynamic document retrieval system** that:

1. **Queries the `team_documents` table** for medicines by name
2. **Downloads documents** (PDF/DOCX) from the backend server
3. **Extracts text** from documents for use as LLM context
4. **Validates extracted content** (HARD FAIL if < 200 characters)
5. **Passes medicine parameter** through the entire API pipeline

---

## Files Modified

### `workers/rag/analysis_service.py` (Core Changes)

#### 1. **Added Imports**

```python
import tempfile
import urllib.request
try:
    import pdfplumber
except ImportError:
    pdfplumber = None
try:
    from docx import Document
except ImportError:
    Document = None
```

#### 2. **Removed Static FACTSHEET**

- ✅ Deleted ~900-character hardcoded Oncaryva™ product information (lines 212-250)
- ✅ Cleaned up namespace for dynamic approach

#### 3. **Added Helper Functions**

**`get_factsheet_doc_path(medicine: str) -> Optional[str]`**

- Queries `team_documents` table
- Uses `FIND_IN_SET()` to search JSON medicines field
- Orders by `uploaded_at DESC` to get latest version
- Returns doc_path or None if not found
- Logs all queries for debugging

**`download_doc(doc_url: str) -> Optional[str]`**

- Handles relative paths (prefixes with `BACKEND_URL` env var)
- Creates temp file with appropriate suffix (.pdf or .docx)
- Uses `urllib.request.urlretrieve()` for HTTP downloads
- Returns temp file path or None on failure

**`extract_text_from_pdf(file_path: str) -> Optional[str]`**

- Uses `pdfplumber` library (safely imported with fallback)
- Extracts text from all pages
- Returns cleaned text or None if not installed/fails

**`extract_text_from_docx(file_path: str) -> Optional[str]`**

- Uses `python-docx` library (safely imported with fallback)
- Extracts all paragraph text
- Returns cleaned text or None if not installed/fails

**`extract_factsheet_text(file_path: str) -> Optional[str]`**

- Dispatcher function that routes to PDF or DOCX extractor
- Detects file type from extension
- Returns extracted text or None if unsupported type

#### 4. **Updated Function Signatures**

**`build_prompt(transcription: str, factsheet: str) -> str`**

- Changed: Removed default parameter `= FACTSHEET`
- Now: Requires explicit factsheet text (no longer optional)
- Impact: Forces all callers to provide dynamic content

**`analyze_transcription_text_and_update_db(row_id: int, transcription: str, medicine: str, model: Optional[str] = None) -> str`**

- Added: `medicine: str` parameter (required, no default)
- Now: Performs complete document retrieval pipeline:
  1. Query DB for medicine doc_path
  2. Download document to temp file
  3. Extract text using appropriate method
  4. Validate text length (HARD FAIL if < 200 chars)
  5. Clean up temp file
  6. Build prompt with dynamic content
  7. Call LLM with extracted context
- Returns: Analysis text without META block

#### 5. **Updated Request Models**

**`AnalyzeByIdRequest`**

- Added: `medicine: str` field (required)
- Model now: `{id: int, medicine: str, model: Optional[str]}`

**`AnalyzeInlineRequest`**

- Added: `medicine: str` field (required)
- Model now: `{transcription: str, medicine: str, model: Optional[str]}`

#### 6. **Updated API Endpoints**

**`POST /api/analyze_by_id`**

- Validates `medicine` field required
- Passes medicine to `analyze_transcription_text_and_update_db()`
- Returns 400 error if medicine is missing
- Returns 404 if no document found for medicine
- Returns 500 if extraction/download fails

**`POST /api/analyze_inline`**

- Validates `medicine` field required
- Passes medicine to `analyze_transcription_text_and_update_db()`
- Row ID = -1 (no DB update, analysis only)

**`POST /api/analyze_by_id_async`**

- Validates `medicine` field required
- Adds medicine to job queue dict
- Returns 400 error if medicine is missing

#### 7. **Updated Worker Loop**

**`worker_loop()`**

- Extracts `medicine` from job dict
- Validates medicine is present (returns failed status if missing)
- Passes medicine to `analyze_transcription_text_and_update_db()`
- Logs job details including medicine name

#### 8. **Updated Sanitization**

**`sanitize_output()`**

- Changed: Default factsheet parameter from `FACTSHEET` to `""`
- Now: Accepts dynamic factsheet text for validation

---

## Database Interactions

### Query Pattern

```sql
SELECT doc_path FROM team_documents
WHERE FIND_IN_SET(?, REPLACE(REPLACE(medicines, '[', ''), ']', ''))
ORDER BY uploaded_at DESC
LIMIT 1
```

### Expected Schema

```
team_documents
├── id (int)
├── doc_path (varchar) - relative or absolute URL
├── medicines (json/varchar) - comma-separated or JSON array of medicine names
├── uploaded_at (timestamp)
└── ... other fields
```

---

## Error Handling

### Hard Failures (ValueError thrown)

1. **No document found** for medicine name
   - Error: "Required factsheet document not found for medicine: {medicine}"
2. **Download fails** (HTTP error, network issue)
   - Error: "Failed to download factsheet document: {doc_path}"
3. **Extraction produces too little text** (< 200 chars)
   - Error: "Extracted factsheet text is insufficient (< 200 chars)"
4. **Missing library** (pdfplumber or python-docx)
   - Gracefully degrades: logs warning, returns None
   - Then triggers hard failure due to text validation

### Soft Failures (Logged but continue)

- Document query DB error
- Temp file cleanup failure
- Library import failure (graceful degradation)

---

## Environment Variables

| Variable             | Default                 | Purpose                         |
| -------------------- | ----------------------- | ------------------------------- |
| `BACKEND_URL`        | `http://localhost:4000` | Base URL for relative doc paths |
| `OPENROUTER_API_KEY` | (required)              | LLM API key                     |
| `DB_HOST`            | `localhost`             | Database host                   |
| `DB_USER`            | `root`                  | Database user                   |
| `DB_PASSWORD`        | ``                      | Database password               |
| `DB_NAME`            | `sqldb`                 | Database name                   |

---

## Dependencies

### New Python Packages Required

```bash
pip install pdfplumber python-docx
```

### Already Installed

- fastapi, uvicorn
- mysql-connector-python
- requests
- python-dotenv

---

## Testing Checklist

- [x] Module imports successfully
- [x] No syntax errors
- [x] All helper functions implemented
- [x] Function signatures updated
- [x] Request models include medicine field
- [x] Endpoints validate medicine parameter
- [x] Worker loop handles medicine from queue
- [x] Error handling with HARD FAIL on missing docs
- [ ] Integration test with actual DB records
- [ ] Test PDF extraction with real PDF file
- [ ] Test DOCX extraction with real DOCX file
- [ ] Test missing/invalid medicine names
- [ ] Test network errors during download
- [ ] Verify temp file cleanup

---

## API Usage Examples

### Before (Hardcoded FACTSHEET)

```bash
curl -X POST http://localhost:5000/api/analyze_by_id \
  -H "Content-Type: application/json" \
  -d '{"id": 123}'
# All analyses used generic Oncaryva™ info
```

### After (Dynamic Document Retrieval)

```bash
curl -X POST http://localhost:5000/api/analyze_by_id \
  -H "Content-Type: application/json" \
  -d '{"id": 123, "medicine": "Oncaryva"}'
# Analysis uses actual factsheet from team_documents
```

### Inline Analysis

```bash
curl -X POST http://localhost:5000/api/analyze_inline \
  -H "Content-Type: application/json" \
  -d '{
    "transcription": "Sales rep discussion...",
    "medicine": "Oncaryva"
  }'
```

### Async Analysis

```bash
curl -X POST http://localhost:5000/api/analyze_by_id_async \
  -H "Content-Type: application/json" \
  -d '{"id": 123, "medicine": "Oncaryva"}'
# Returns: {"ok": true, "job_id": "uuid..."}
```

---

## Backwards Compatibility

⚠️ **Breaking Changes**: All API consumers MUST update to include `medicine` field in requests.

### Migration Path

1. Update frontend to capture selected medicine
2. Update API calls to include medicine parameter
3. Ensure team_documents table has correct medicines entries
4. Verify documents are accessible at doc_path URLs
5. Test with actual medicine names from your database

---

## Future Enhancements

1. **Caching**: Store extracted text in Redis for 24 hours
2. **Vector embedding**: Store document embeddings for semantic search
3. **Multiple documents**: Support concatenating multiple docs per medicine
4. **Metadata**: Extract title, author, version from document metadata
5. **OCR**: Handle scanned PDFs with OCR support
6. **Language detection**: Automatically handle multi-language documents

---

## Deployment Notes

1. **Production**: Remove `--reload` flag from uvicorn
2. **Dependencies**: Install `pdfplumber` and `python-docx` in production venv
3. **Permissions**: Ensure backend can serve files from uploads directory
4. **Timeout**: Consider increasing LLM timeout for longer documents
5. **Logging**: Review logs for any "factsheet document not found" errors

---

## Contact

For issues or questions about document retrieval implementation:

- Check logs for "Retrieving factsheet" messages
- Verify team_documents table has correct data
- Confirm BACKEND_URL points to correct server
- Test with curl/Postman before frontend integration

---

**Status**: ✅ Implementation Complete - Ready for Integration Testing
