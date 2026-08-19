from rest_framework.authentication import SessionAuthentication as BaseSessionAuthentication


class SessionAuthentication(BaseSessionAuthentication):
    def authenticate_header(self, request):
        return 'Session'
