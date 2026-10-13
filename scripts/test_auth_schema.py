"""Verify D1/SQLite auth schema and database-enforced tenant invariants.

No external dependencies; runs in CI with system Python 3.
"""
from pathlib import Path
import sqlite3
import tempfile


def must_fail(action, message):
    try:
        action()
    except sqlite3.IntegrityError:
        return
    raise AssertionError(message)


with tempfile.TemporaryDirectory() as temp:
    con = sqlite3.connect(str(Path(temp) / "auth.db"))
    con.execute("PRAGMA foreign_keys=ON")
    for migration in sorted(Path("migrations").glob("*.sql")):
        con.executescript(migration.read_text(encoding="utf-8"))
    def user(uid):
        con.execute(
            'INSERT INTO "user"(id,name,email,email_verified,created_at,updated_at) VALUES(?,?,?,?,?,?)',
            (uid, uid, uid + "@example.org", 1, 1, 1),
        )
    def org(oid):
        con.execute('INSERT INTO "organization"(id,name,slug,created_at) VALUES(?,?,?,?)',
                    (oid, oid, oid, 1))
    def join(mid, uid, oid, role):
        con.execute(
            'INSERT INTO "member"(id,user_id,organization_id,role,created_at) VALUES(?,?,?,?,?)',
            (mid, uid, oid, role, 1),
        )
    for uid in ("alice", "bob", "carol"):
        user(uid)
    for oid in ("org-a", "org-b"):
        org(oid)
    join("member-a", "alice", "org-a", "admin")
    join("member-b", "bob", "org-a", "member")
    must_fail(lambda: join("member-cross", "bob", "org-b", "member"),
              "A user joined two organizations")
    must_fail(lambda: con.execute("UPDATE member SET role='member' WHERE id='member-a'"),
              "The final admin was demoted")
    must_fail(lambda: con.execute("DELETE FROM member WHERE id='member-a'"),
              "The final admin left")
    must_fail(lambda: con.execute("UPDATE member SET role='owner' WHERE id='member-b'"),
              "Unsupported owner role was accepted")
    con.execute("UPDATE member SET role='admin' WHERE id='member-b'")
    con.execute("DELETE FROM member WHERE id='member-a'")
    must_fail(lambda: con.execute("DELETE FROM member WHERE id='member-b'"),
              "Remaining admin was allowed to leave")
    must_fail(lambda: con.execute("UPDATE member SET organization_id='org-b' WHERE id='member-b'"),
              "Remaining admin moved out of organization")
    join("member-c", "carol", "org-b", "admin")
    assert not con.execute("PRAGMA foreign_key_check").fetchall()
    print("D1 schema and organization integrity constraints: PASS")
