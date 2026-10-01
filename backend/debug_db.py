import pymysql

db_config = {
    "host": "localhost",
    "user": "root",
    "password": "123456",
    "database": "tc"
}

try:
    conn = pymysql.connect(**db_config)
    cursor = conn.cursor()
    
    # List tables
    cursor.execute("SHOW TABLES")
    tables = cursor.fetchall()
    print("Tables:", [t[0] for t in tables])
    
    for (table_name,) in tables:
        print(f"\nSchema for {table_name}:")
        cursor.execute(f"DESCRIBE {table_name}")
        columns = cursor.fetchall()
        for col in columns:
            print(f"  {col[0]} ({col[1]})")
            
    conn.close()
except Exception as e:
    print("Connection failed:", e)
