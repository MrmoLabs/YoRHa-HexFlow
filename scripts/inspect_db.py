import sqlite3
import json
from pathlib import Path

# DB path is resolved relative to this script (repo_root/backend/db/yorha.db),
# so the script works regardless of the current working directory.
DB_PATH = Path(__file__).resolve().parents[1] / 'backend' / 'db' / 'yorha.db'


def inspect_db():
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()

    print("--- Instructions ---")
    c.execute("SELECT id, name FROM instructions")
    for row in c.fetchall():
        print(f"ID: {row[0]}, Name: {row[1]}")

    print("\n--- Fields for '嵌套指令' ---")
    c.execute("""
        SELECT f.id, f.name, f.op_code, f.parameter_config 
        FROM instruction_fields f 
        JOIN instructions i ON f.instruction_id = i.id 
        WHERE i.name = '嵌套指令'
    """)
    for row in c.fetchall():
        print(f"Name: {row[1]}, Op: {row[2]}")
        if row[3]:
            try:
                params = json.loads(row[3])
                print(f"  Params: {json.dumps(params, indent=2)}")
            except:
                print(f"  Raw Params: {row[3]}")

    conn.close()

if __name__ == "__main__":
    inspect_db()
