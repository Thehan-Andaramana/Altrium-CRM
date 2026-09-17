from rest_framework.permissions import SAFE_METHODS, BasePermission

from .models import ApprovalRequest, Lead, User

FULL_ACCESS_ROLES = {
    User.Role.SALES_MANAGER,
    User.Role.EXECUTIVE_MANAGER,
    User.Role.SYSTEM_ADMIN,
}

# Distinct from FULL_ACCESS_ROLES: for Company/Lead/Project specifically,
# SYSTEM_ADMIN no longer has general management rights (see
# CompanyPermission / ArchivableOwnedResourcePermission below) -- only
# SALES_MANAGER and EXECUTIVE_MANAGER can create, update, archive, or
# unarchive those three models.
MANAGER_ROLES = {
    User.Role.SALES_MANAGER,
    User.Role.EXECUTIVE_MANAGER,
}


class RoleBasedAccess(BasePermission):
    """
    SALES_REP: full access, but only to records they own / are assigned to.
    SALES_MANAGER, EXECUTIVE_MANAGER, SYSTEM_ADMIN: full access to all records.
    PROJECT_MANAGER: read-only, except full write on an object tied to a
    project they manage (see project_manager_id on Project/PhaseRequirement)
    -- an Interaction has no such property, so PM stays read-only there.
    """

    def has_permission(self, request, view):
        role = request.user.role
        if role == User.Role.PROJECT_MANAGER:
            return request.method != 'POST'
        return True

    def has_object_permission(self, request, view, obj):
        role = request.user.role
        if role == User.Role.PROJECT_MANAGER:
            if request.method in SAFE_METHODS:
                return True
            return getattr(obj, 'project_manager_id', None) == request.user.id
        if role in FULL_ACCESS_ROLES:
            return True
        if role == User.Role.SALES_REP:
            return (
                getattr(obj, 'owner_id', None) == request.user.id
                or getattr(obj, 'assigned_to_id', None) == request.user.id
            )
        return False


class CompanyPermission(BasePermission):
    """
    SALES_REP: read access to every company, write access only to ones they
    own or have an assigned lead against (they can open any other company
    read-only).
    SALES_MANAGER, EXECUTIVE_MANAGER: full access, including archive/unarchive.
    SYSTEM_ADMIN: read-only, plus hard-delete -- but only of an already
    archived company. No create/update/archive/unarchive.
    PROJECT_MANAGER: read-only access to all records.
    """

    def has_permission(self, request, view):
        role = request.user.role
        if role == User.Role.PROJECT_MANAGER:
            return request.method in SAFE_METHODS
        if view.action in ('archive', 'unarchive'):
            return role in MANAGER_ROLES
        if request.method == 'DELETE':
            return role == User.Role.SYSTEM_ADMIN
        if role == User.Role.SYSTEM_ADMIN:
            return request.method in SAFE_METHODS
        return True

    def has_object_permission(self, request, view, obj):
        role = request.user.role
        if role == User.Role.PROJECT_MANAGER:
            return request.method in SAFE_METHODS
        if view.action in ('archive', 'unarchive'):
            return role in MANAGER_ROLES
        if request.method == 'DELETE':
            return role == User.Role.SYSTEM_ADMIN and obj.is_archived
        if role == User.Role.SYSTEM_ADMIN:
            return request.method in SAFE_METHODS
        if role in MANAGER_ROLES:
            return True
        if role == User.Role.SALES_REP:
            if request.method in SAFE_METHODS:
                return True
            return obj.owner_id == request.user.id or obj.leads.filter(assigned_to=request.user).exists()
        return False


class ContactPermission(BasePermission):
    """
    SALES_REP: read access to every contact, write access (create/update)
    only on companies where they have an assigned lead.
    SALES_MANAGER, EXECUTIVE_MANAGER: full access, including archive/unarchive.
    SYSTEM_ADMIN: read-only, plus hard-delete -- but only of an already
    archived contact. No create/update/archive/unarchive.
    PROJECT_MANAGER: read-only access to all records.
    """

    def has_permission(self, request, view):
        role = request.user.role
        if role == User.Role.PROJECT_MANAGER:
            return request.method in SAFE_METHODS
        if view.action in ('archive', 'unarchive'):
            return role in MANAGER_ROLES
        if request.method == 'DELETE':
            return role == User.Role.SYSTEM_ADMIN
        if role == User.Role.SYSTEM_ADMIN:
            return request.method in SAFE_METHODS
        if role == User.Role.SALES_REP and view.action == 'create':
            return Lead.objects.filter(
                company_id=request.data.get('company'), assigned_to=request.user,
            ).exists()
        return True

    def has_object_permission(self, request, view, obj):
        role = request.user.role
        if role == User.Role.PROJECT_MANAGER:
            return request.method in SAFE_METHODS
        if view.action in ('archive', 'unarchive'):
            return role in MANAGER_ROLES
        if request.method == 'DELETE':
            return role == User.Role.SYSTEM_ADMIN and obj.is_archived
        if role == User.Role.SYSTEM_ADMIN:
            return request.method in SAFE_METHODS
        if role in MANAGER_ROLES:
            return True
        if role == User.Role.SALES_REP:
            if request.method in SAFE_METHODS:
                return True
            return obj.company.leads.filter(assigned_to=request.user).exists()
        return False


class ArchivableOwnedResourcePermission(BasePermission):
    """
    Like CompanyPermission, but without the "any role can read" carve-out --
    SALES_REP only has access (read or write) to records they own or are
    assigned to. Used by Lead and Project.

    PROJECT_MANAGER: read-only on everything this guards, except full write
    on a Project (and, via RoleBasedAccess, its PhaseRequirement rows) they
    are the assigned project_manager for -- a Lead has no project_manager_id,
    so PM stays read-only there.
    """

    def has_permission(self, request, view):
        role = request.user.role
        if role == User.Role.PROJECT_MANAGER:
            if view.action in ('archive', 'unarchive'):
                return False
            return request.method not in ('POST', 'DELETE')
        if view.action in ('archive', 'unarchive'):
            return role in MANAGER_ROLES
        if request.method == 'DELETE':
            return role == User.Role.SYSTEM_ADMIN
        if role == User.Role.SYSTEM_ADMIN:
            return request.method in SAFE_METHODS
        return True

    def has_object_permission(self, request, view, obj):
        role = request.user.role
        if role == User.Role.PROJECT_MANAGER:
            if request.method in SAFE_METHODS:
                return True
            return getattr(obj, 'project_manager_id', None) == request.user.id
        if view.action in ('archive', 'unarchive'):
            return role in MANAGER_ROLES
        if request.method == 'DELETE':
            return role == User.Role.SYSTEM_ADMIN and obj.is_archived
        if role == User.Role.SYSTEM_ADMIN:
            return request.method in SAFE_METHODS
        if role in MANAGER_ROLES:
            return True
        if role == User.Role.SALES_REP:
            return (
                getattr(obj, 'owner_id', None) == request.user.id
                or getattr(obj, 'assigned_to_id', None) == request.user.id
            )
        return False


class ManagementRolePermission(BasePermission):
    """Restricts a view to SALES_MANAGER, EXECUTIVE_MANAGER, and SYSTEM_ADMIN."""

    def has_permission(self, request, view):
        return request.user.role in FULL_ACCESS_ROLES


class ApprovalRequestPermission(BasePermission):
    """
    SALES_REP: may create requests and only read their own.
    PROJECT_MANAGER: may create requests; reads their own plus any tied to a
    project they manage.
    Management roles: may read all and PATCH status (approve/reject), but
    never decide a request they submitted themselves. PHASE_4_SIGNOFF is a
    further exception -- only EXECUTIVE_MANAGER may decide it, not just any
    FULL_ACCESS_ROLES member.
    """

    def has_permission(self, request, view):
        if view.action == 'create':
            return True
        if request.method in SAFE_METHODS:
            return True
        return request.user.role in FULL_ACCESS_ROLES

    def has_object_permission(self, request, view, obj):
        role = request.user.role
        if request.method in SAFE_METHODS:
            if role in FULL_ACCESS_ROLES or obj.requested_by_id == request.user.id:
                return True
            if role == User.Role.PROJECT_MANAGER:
                return obj.project_id is not None and obj.project.project_manager_id == request.user.id
            return False
        # Only PATCH reaches here -- has_permission already blocked everyone
        # else, and the viewset doesn't offer PUT/DELETE.
        if obj.request_type == ApprovalRequest.RequestType.PHASE_4_SIGNOFF and role != User.Role.EXECUTIVE_MANAGER:
            return False
        return obj.requested_by_id != request.user.id


class SystemSettingsPermission(BasePermission):
    """GET is open to any authenticated user; PATCH is restricted to management roles."""

    MANAGE_ROLES = {
        User.Role.SALES_MANAGER,
        User.Role.EXECUTIVE_MANAGER,
        User.Role.SYSTEM_ADMIN,
    }

    def has_permission(self, request, view):
        if request.method in SAFE_METHODS:
            return True
        return request.user.role in self.MANAGE_ROLES


class ManagementWritePermission(BasePermission):
    """GET is open to any authenticated user; writes are restricted to management roles."""

    def has_permission(self, request, view):
        if request.method in SAFE_METHODS:
            return True
        return request.user.role in FULL_ACCESS_ROLES
