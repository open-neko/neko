import { describe, expect, it } from "vitest";
import { validateRecordIdentifier } from "../src/naming";
import { projectEffectiveRecordAccess } from "../src/policy/access";
import type { AppRegistrySnapshot } from "../src/types";

const id = validateRecordIdentifier;

function snapshot(): AppRegistrySnapshot {
  return {
    revision: "1",
    app: {
      orgId: "org-1",
      appId: "crm",
      label: "CRM",
      purpose: null,
      status: "active",
      navOrder: 0,
      registryRevision: "1",
    },
    objects: [
      {
        id: "object-activity",
        orgId: "org-1",
        appId: "crm",
        apiName: id("activity"),
        sourceApiName: null,
        label: "Activity",
        pluralLabel: "Activities",
        tableSchema: id("public"),
        tableName: id("crm__activity"),
        nameField: id("subject"),
        visibility: "org",
        custom: false,
        archivedAt: null,
        recordCount: "10",
      },
    ],
    fields: [
      {
        id: "field-subject",
        orgId: "org-1",
        objectId: "object-activity",
        apiName: id("subject"),
        sourceApiName: null,
        label: "Subject",
        kind: "text",
        columnName: id("subject"),
        required: true,
        readOnly: false,
        archivedAt: null,
        picklistValues: null,
        referenceTargets: null,
        length: 200,
        scale: null,
      },
      {
        id: "field-private",
        orgId: "org-1",
        objectId: "object-activity",
        apiName: id("private_note"),
        sourceApiName: null,
        label: "Private note",
        kind: "textarea",
        columnName: id("private_note"),
        required: false,
        readOnly: false,
        archivedAt: null,
        picklistValues: null,
        referenceTargets: null,
        length: null,
        scale: null,
      },
    ],
    layouts: [
      {
        objectId: "object-activity",
        kind: "detail",
        definition: {
          sections: [{ fields: ["subject", "private_note"] }],
        },
      },
    ],
    pages: [],
    permissions: [
      {
        appId: "crm",
        role: "member",
        objectApiName: id("activity"),
        canRead: true,
        canCreate: true,
        canUpdate: false,
        canDelete: false,
      },
      {
        appId: "crm",
        role: "admin",
        objectApiName: id("activity"),
        canRead: true,
        canCreate: true,
        canUpdate: true,
        canDelete: true,
      },
    ],
  };
}

describe("subject entitlement projection", () => {
  it("denies the app without an explicit user/group/upgrade grant", () => {
    expect(
      projectEffectiveRecordAccess({
        snapshot: snapshot(),
        actor: { userId: "user-1", role: "member", solo: false },
        access: { app: false, objects: [], fields: [] },
      }),
    ).toBeNull();
  });

  it("unions resolved subject grants, filters fields, and honors the role ceiling", () => {
    const projected = projectEffectiveRecordAccess({
      snapshot: snapshot(),
      actor: {
        userId: "user-1",
        role: "member",
        groupIds: ["group-sales"],
        solo: false,
      },
      access: {
        app: true,
        objects: [
          {
            objectApiName: "activity",
            canRead: true,
            canCreate: true,
            canUpdate: true,
            canDelete: true,
          },
        ],
        fields: [
          { fieldId: "field-subject", canRead: true, canWrite: true },
        ],
      },
    });
    expect(projected).not.toBeNull();
    expect(projected?.permissions).toEqual([
      expect.objectContaining({
        role: "member",
        canRead: true,
        canCreate: true,
        canUpdate: false,
        canDelete: false,
      }),
    ]);
    expect(projected?.fields).toEqual([
      expect.objectContaining({ apiName: "subject", readOnly: false }),
    ]);
    expect(projected?.layouts[0]?.definition).toEqual({
      sections: [{ fields: ["subject"] }],
    });
  });

  it("gives only the synthetic solo operator full access", () => {
    const projected = projectEffectiveRecordAccess({
      snapshot: snapshot(),
      actor: {
        userId: "urn:openneko:solo-admin:org-1",
        role: "admin",
        solo: true,
      },
      access: { app: true, objects: [], fields: [] },
    });
    expect(projected?.fields).toHaveLength(2);
    expect(projected?.permissions[0]).toMatchObject({
      canRead: true,
      canCreate: true,
      canUpdate: true,
      canDelete: true,
    });
    expect(() =>
      projectEffectiveRecordAccess({
        snapshot: snapshot(),
        actor: { userId: "member-1", role: "member", solo: true },
        access: { app: true, objects: [], fields: [] },
      }),
    ).toThrow(/synthetic local admin/);
  });
});
