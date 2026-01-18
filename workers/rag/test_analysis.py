#!/usr/bin/env python3
"""Check database columns for audio_recordings"""
import os
import mysql.connector
from dotenv import load_dotenv

load_dotenv()

# Connect to DB
conn = mysql.connector.connect(
    host=os.getenv("DB_HOST", "localhost"),
    user=os.getenv("DB_USER", "root"),
    password=os.getenv("DB_PASSWORD", "root123"),
    database=os.getenv("DB_NAME", "sqldb"),
)

cursor = conn.cursor()

# Show all columns in audio_recordings table
cursor.execute("SHOW COLUMNS FROM audio_recordings")
columns = cursor.fetchall()
print("Columns in audio_recordings table:")
print("-" * 80)
for col in columns:
    print(f"{col[0]:<30} {col[1]:<20} {col[2]:<10} {col[3]:<10}")

print("\n" + "=" * 80)
print("Checking if score and keywords_of_improvement exist:")
col_names = [c[0] for c in columns]
print(f"  score exists: {'score' in col_names}")
print(f"  keywords_of_improvement exists: {'keywords_of_improvement' in col_names}")

cursor.close()
conn.close()
