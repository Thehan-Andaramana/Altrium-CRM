from rest_framework.permissions import SAFE_METHODS, BasePermission

from .models import ApprovalRequest, Lead, PhaseRequirement, Project, User

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
    project they manage (see project_manager_id on Project/PhaseRequirement),
    or -- for Interaction specifically, which has no such property -- on a
    new interaction logged against a lead whose project they manage (needed
    so a PM can tag a task in a note at all; see Interaction.project_manager_id).
    """

    def has_permission(self, request, view):
        role = request.user.role
        if role == User.Role.PROJECT_MANAGER:
            if request.method != 'POST':
                return True
            lead_id = request.data.get('lead')
            lead = Lead.objects.select_related('project').filter(pk=lead_id).first() if lead_id else None
            return lead is not None and lead.project.project_manager_id == request.user.id
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


class PhaseRequirementPermission(BasePermission):
    """
    Read/update: same scoping as everywhere else -- SALES_REP on a project
    for a lead they're assigned, PROJECT_MANAGER on a project they manage,
    management roles anywhere.
    Create: a custom task, subject to that same scoping -- resolved from
    `project` in the request body, since there's no object yet.
    Delete: only ever allowed when the target task is_custom -- a
    template-derived task can never be deleted, by anyone.
    Answers (a detail action, not the "create a task" POST): scoped the same
    way, but re-checked via has_object_permission like any other detail
    action, since the task already exists.
    """

    @staticmethod
    def _scoped_to(role, user_id, project):
        if role in FULL_ACCESS_ROLES:
            return True
        if role == User.Role.SALES_REP:
            return project.lead.assigned_to_id == user_id
        if role == User.Role.PROJECT_MANAGER:
            return project.project_manager_id == user_id
        return False

    def has_permission(self, request, view):
        # Only the "create a new task" POST needs resolving here (there's no
        # object yet); every other POST -- including the answers detail
        # action -- already has one, so has_object_permission handles it.
        if request.method != 'POST' or view.action != 'create':
            return True
        project_id = request.data.get('project')
        if not project_id:
            return False
        project = Project.objects.select_related('lead').filter(pk=project_id).first()
        if project is None:
            return False
        return self._scoped_to(request.user.role, request.user.id, project)

    def has_object_permission(self, request, view, obj):
        if not self._scoped_to(request.user.role, request.user.id, obj.project):
            return False
        if request.method == 'DELETE':
            return obj.is_custom
        return True


class TaskAttachmentPermission(BasePermission):
    """
    Read/create: same project-scoping as PhaseRequirementPermission --
    whoever can see/edit the parent task can see and add its attachments.
    Delete: restricted to the uploader or a MANAGER_ROLES member -- narrower
    than "can edit the task" (which also includes the assigned rep/PM even
    when they didn't upload the file).
    """

    def has_permission(self, request, view):
        if request.method != 'POST':
            return True
        requirement_id = request.data.get('requirement')
        if not requirement_id:
            return False
        requirement = PhaseRequirement.objects.select_related('project__lead').filter(pk=requirement_id).first()
        if requirement is None:
            return False
        return PhaseRequirementPermission._scoped_to(request.user.role, request.user.id, requirement.project)

    def has_object_permission(self, request, view, obj):
        if not PhaseRequirementPermission._scoped_to(request.user.role, request.user.id, obj.requirement.project):
            return False
        if request.method == 'DELETE':
            return request.user.role in MANAGER_ROLES or obj.uploaded_by_id == request.user.id
        return True


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


class ReportingPermission(BasePermission):
    """
    Reporting is management-only, read-only: SALES_MANAGER,
    EXECUTIVE_MANAGER and SYSTEM_ADMIN (FULL_ACCESS_ROLES) -- the same three
    roles that already see every record, which is what a cross-rep,
    cross-PM report necessarily exposes. A rep or PM would only ever see
    their own slice, and the dashboard already gives them that.
    """

    def has_permission(self, request, view):
        return request.method in SAFE_METHODS and request.user.role in FULL_ACCESS_ROLES
