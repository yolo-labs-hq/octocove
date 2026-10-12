# Local SQLite test adapter: exercise the actual migration and SQL, not a mocked log.
import json, sqlite3, sys


def execute(request):
    db = sqlite3.connect(request['path'])
    # Ubuntu's Python SQLite predates unixepoch(), which the production migrations use.
    db.create_function('unixepoch', -1, lambda *modifiers: __import__('time').time()
                       if modifiers == ('subsec',) else int(__import__('time').time()))
    db.execute('PRAGMA foreign_keys=ON')
    try:
        if 'script' in request:
            db.executescript(request['script'])
            return []
        result = []
        db.execute('BEGIN')
        for statement in request['statements']:
            cursor = db.execute(statement['sql'], statement.get('params', []))
            # D1 projects the last value of duplicate column names (e.g. g.*,r.id).
            rows = [{column[0]: row[index] for index, column in enumerate(cursor.description)}
                    for row in cursor.fetchall()] if cursor.description else []
            result.append({'success': True, 'results': rows})
        db.commit()
        return result
    except Exception as error:
        db.rollback()
        return {'error': str(error)}
    finally:
        db.close()


if '--serve' in sys.argv:
    # One child, sequential requests. Avoid a Python process per D1 statement in
    # repeated native journeys; no network, background writers or shared state.
    for line in sys.stdin:
        print(json.dumps(execute(json.loads(line))), flush=True)
else:
    print(json.dumps(execute(json.load(sys.stdin))))
