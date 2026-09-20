import psycopg2
from django.conf import settings
from django.core.management.base import BaseCommand
from psycopg2 import sql
from psycopg2.extensions import ISOLATION_LEVEL_AUTOCOMMIT


class Command(BaseCommand):
    help = (
        'Create the database named by DATABASE_URL if it does not exist yet. '
        'Used to stand up the isolated end-to-end database before migrating it -- '
        '`migrate` can create tables, but not the database to put them in.'
    )

    def handle(self, *args, **options):
        config = settings.DATABASES['default']
        target = config['NAME']

        # CREATE DATABASE can't run inside a transaction, and can't run from
        # a connection to the database being created -- so this connects to
        # the server's own default database with the same credentials.
        connection = psycopg2.connect(
            host=config.get('HOST') or 'localhost',
            port=config.get('PORT') or 5432,
            user=config.get('USER'),
            password=config.get('PASSWORD'),
            dbname='postgres',
        )
        connection.set_isolation_level(ISOLATION_LEVEL_AUTOCOMMIT)
        try:
            with connection.cursor() as cursor:
                cursor.execute('SELECT 1 FROM pg_database WHERE datname = %s', (target,))
                if cursor.fetchone():
                    self.stdout.write(f'Database "{target}" already exists.')
                    return
                cursor.execute(sql.SQL('CREATE DATABASE {}').format(sql.Identifier(target)))
            self.stdout.write(self.style.SUCCESS(f'Created database "{target}".'))
        finally:
            connection.close()
