from django.urls import path

from . import views

urlpatterns = [
    path('csrf/', views.csrf, name='auth-csrf'),
    path('login/', views.login_view, name='auth-login'),
    path('logout/', views.logout_view, name='auth-logout'),
    path('me/', views.me, name='auth-me'),
]
