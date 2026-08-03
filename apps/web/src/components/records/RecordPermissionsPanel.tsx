import type { AppRegistrySnapshot } from "@neko/records";

function Grant({ allowed }: { allowed: boolean }) {
  return <span className={`records-permission-grant ${allowed ? "is-allowed" : "is-denied"}`}>{allowed ? "Allowed" : "Denied"}</span>;
}

export function RecordPermissionsPanel({
  objects,
  permissions,
}: {
  objects: AppRegistrySnapshot["objects"];
  permissions: AppRegistrySnapshot["permissions"];
}) {
  return (
    <section className="records-admin-panel">
      <header>
        <div>
          <h2>Object permissions</h2>
          <p>These grants govern generated forms and agent record actions through the same policy snapshot.</p>
        </div>
      </header>
      <div className="records-admin-table-scroll">
        <table className="records-admin-table">
          <thead><tr><th>Role</th><th>Object</th><th>Read</th><th>Create</th><th>Update</th><th>Delete</th></tr></thead>
          <tbody>
            {permissions.map((permission) => {
              const object = objects.find((candidate) => candidate.apiName === permission.objectApiName);
              if (!object) return null;
              return (
                <tr key={`${permission.role}-${permission.objectApiName}`}>
                  <td><strong>{permission.role}</strong></td>
                  <td>{object.label}<small>{object.apiName}</small></td>
                  <td><Grant allowed={permission.canRead} /></td>
                  <td><Grant allowed={permission.canCreate} /></td>
                  <td><Grant allowed={permission.canUpdate} /></td>
                  <td><Grant allowed={permission.canDelete} /></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <footer>Permission changes are schema actions and require an approved <code>app_permission_set</code> request.</footer>
    </section>
  );
}
