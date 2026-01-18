# Document Retrieval Implementation - Testing Guide

## Quick Verification

### 1. Module Import Test

```bash
cd role-based-auth
.venv\Scripts\python.exe -c "import workers.rag.analysis_service; print('✓ Module loads')"
```

**Expected Output:**

```
INFO:analysis-service:DB pool created.
INFO:analysis-service:Analysis worker thread started (OPENROUTER=sk-or-...)
✓ Module loads
```

### 2. API Request Format - /api/analyze_by_id

**Before (Hardcoded):**

```json
{
  "id": 123
}
```

**After (Dynamic):**

```json
{
  "id": 123,
  "medicine": "Oncaryva",
  "model": "deepseek/deepseek-chat"
}
```

### 3. API Request Format - /api/analyze_inline

**Before (Hardcoded):**

```json
{
  "transcription": "Sales rep discussion...",
  "model": "deepseek/deepseek-chat"
}
```

**After (Dynamic):**

```json
{
  "transcription": "Sales rep discussion...",
  "medicine": "Oncaryva",
  "model": "deepseek/deepseek-chat"
}
```

### 4. API Request Format - /api/analyze_by_id_async

**Before (Hardcoded):**

```json
{
  "id": 123
}
```

**After (Dynamic):**

```json
{
  "id": 123,
  "medicine": "Oncaryva",
  "model": "deepseek/deepseek-chat"
}
```

---

## Integration Testing Steps

### Step 1: Verify Database Records

```sql
-- Check team_documents table has your medicine
SELECT id, doc_path, medicines, uploaded_at
FROM team_documents
LIMIT 5;

-- Example output:
-- id=1, doc_path='uploads/Oncaryva_Factsheet.pdf', medicines='["Oncaryva"]'
-- id=2, doc_path='uploads/Medicine_XYZ.docx', medicines='["Medicine XYZ", "XYZ-Generic"]'
```

### Step 2: Start Analysis Service

```bash
cd role-based-auth
python -m uvicorn workers.rag.analysis_service:app --host 0.0.0.0 --port 5000
```

**Expected Output:**

```
INFO:     Started server process [PID]
INFO:     Waiting for application startup.
INFO:analysis-service:DB pool created.
INFO:analysis-service:Analysis worker thread started (OPENROUTER=sk-or-v7-...)
INFO:     Application startup complete.
```

### Step 3: Test Direct Analysis

```bash
curl -X POST http://localhost:5000/api/analyze_by_id \
  -H "Content-Type: application/json" \
  -d '{
    "id": 123,
    "medicine": "Oncaryva"
  }'
```

**Expected Success Response:**

```json
{
  "ok": true,
  "analysis": "==========================\n ANALYSIS REPORT\n==========================\n..."
}
```

**Expected Error - Missing Medicine:**

```json
{
  "detail": "medicine field required"
}
```

**Expected Error - No Document:**

```json
{
  "detail": "Required factsheet document not found for medicine: InvalidMedicine"
}
```

### Step 4: Check Service Logs

Look for these log messages indicating successful document retrieval:

```
INFO:analysis-service:Retrieving factsheet for medicine: Oncaryva
INFO:analysis-service:Found factsheet document for medicine 'Oncaryva': uploads/Oncaryva_Factsheet.pdf
INFO:analysis-service:Downloading document from: http://localhost:4000/uploads/Oncaryva_Factsheet.pdf
INFO:analysis-service:Document downloaded to: C:\Temp\tmp123abc.pdf
INFO:analysis-service:Extracted 4523 characters from PDF
INFO:analysis-service:Factsheet extracted: 4523 characters
INFO:analysis-service:Calling LLM for row_id=123 model=deepseek/deepseek-chat
```

### Step 5: Test Async Analysis

```bash
curl -X POST http://localhost:5000/api/analyze_by_id_async \
  -H "Content-Type: application/json" \
  -d '{
    "id": 123,
    "medicine": "Oncaryva"
  }'
```

**Expected Response:**

```json
{
  "ok": true,
  "job_id": "a1b2c3d4-e5f6-4789-abc0-def123456789"
}
```

### Step 6: Check Async Job Status

```bash
curl http://localhost:5000/api/analysis_status?job_id=a1b2c3d4-e5f6-4789-abc0-def123456789
```

**Expected Response (In Progress):**

```json
{
  "ok": true,
  "job_id": "a1b2c3d4-e5f6-4789-abc0-def123456789",
  "status": {
    "status": "started",
    "id": 123,
    "medicine": "Oncaryva",
    "started_at": 1234567890.123
  }
}
```

**Expected Response (Finished):**

```json
{
  "ok": true,
  "job_id": "a1b2c3d4-e5f6-4789-abc0-def123456789",
  "status": {
    "status": "finished",
    "id": 123,
    "medicine": "Oncaryva",
    "result": "==========================\n ANALYSIS REPORT\n...",
    "started_at": 1234567890.123
  }
}
```

---

## Troubleshooting

### Issue: "No factsheet document found for medicine"

**Solution:**

1. Check `team_documents` table has records with this medicine name
2. Verify medicines field contains exact medicine name (case-sensitive)
3. Check `doc_path` is accessible and correct

### Issue: "pdfplumber not installed"

**Solution:**

```bash
pip install pdfplumber
```

### Issue: "python-docx not installed"

**Solution:**

```bash
pip install python-docx
```

### Issue: "Failed to download factsheet document"

**Solution:**

1. Verify `BACKEND_URL` environment variable is set correctly
2. Check backend server is running on port 4000
3. Verify file exists at the doc_path URL
4. Check file permissions and access

### Issue: "Extracted factsheet text is insufficient"

**Solution:**

1. Document may be too short or in unsupported format
2. Try PDF/DOCX conversion if original is different format
3. Ensure document has at least 200 characters of extractable text

### Issue: Module imports but service won't start

**Solution:**

1. Verify all dependencies installed: `pip install -r requirements.txt`
2. Check OPENROUTER_API_KEY is set
3. Verify MySQL connection string is correct
4. Check database is running and accessible

---

## Performance Testing

### Test with Multiple Medicines

```bash
for medicine in "Oncaryva" "Medicine_XYZ" "Another_Drug"; do
  curl -X POST http://localhost:5000/api/analyze_by_id \
    -H "Content-Type: application/json" \
    -d "{\"id\": 123, \"medicine\": \"$medicine\"}"
done
```

### Measure Extraction Time

The logs will show:

- Query time (ms): "Found factsheet document for medicine"
- Download time (s): "Document downloaded to"
- Extraction time (ms): "Extracted X characters from"
- LLM time (s): "Calling LLM"

---

## Frontend Integration

### Update Request Payload

```typescript
// Before
const payload = {
  id: recordingId,
};

// After
const payload = {
  id: recordingId,
  medicine: selectedMedicine, // From brand selector dropdown
};
```

### Example with Dashboard

```typescript
// In Dashboard.tsx, when analyzing a recording:
const medicine = brandSelector.value; // e.g., "Oncaryva"

const response = await fetch("http://localhost:5000/api/analyze_by_id", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    id: recordingId,
    medicine: medicine, // NEW: Dynamic medicine selection
  }),
});
```

---

## Rollback Plan

If you need to revert to hardcoded FACTSHEET:

1. **Comment out document retrieval:**

   ```python
   # logger.info(f"Retrieving factsheet for medicine: {medicine}")
   # doc_path = get_factsheet_doc_path(medicine)
   # ... (rest of retrieval code)

   # Fallback to hardcoded:
   factsheet_text = "ONCARYVA PRODUCT INFORMATION..."  # Static text
   ```

2. **Remove medicine parameter requirement:**

   ```python
   def analyze_transcription_text_and_update_db(
       row_id: int,
       transcription: str,
       medicine: str = None,  # Make optional
       model: Optional[str] = None
   ) -> str:
       # Only use medicine if provided, otherwise hardcoded
       if medicine:
           factsheet_text = # retrieval logic
       else:
           factsheet_text = "HARDCODED..."
   ```

3. **Make medicine optional in API models:**
   ```python
   class AnalyzeByIdRequest(BaseModel):
       id: int
       medicine: Optional[str] = None  # Now optional
       model: Optional[str] = None
   ```

---

## Success Criteria

- [x] Service starts without errors
- [x] Module imports correctly
- [x] Helper functions exist and are callable
- [x] API endpoints accept medicine parameter
- [x] Database queries execute for valid medicines
- [x] Documents download and extract successfully
- [ ] Integration test with actual frontend
- [ ] Performance test with multiple medicines
- [ ] Error handling verified for all edge cases
- [ ] Logs are clear and helpful for debugging

---

**Last Updated**: Implementation Complete
**Status**: Ready for Integration Testing with Frontend
