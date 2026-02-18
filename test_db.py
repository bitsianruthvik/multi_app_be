import mysql.connector

try:
    conn = mysql.connector.connect(
        host="hopper.proxy.rlwy.net",
        port=52309,
        user="root",
        password="YOUR_PASSWORD",
        database="railway"
    )
    print("✅ Connected successfully!")
    conn.close()
except Exception as e:
    print("❌ Connection failed:", e)
