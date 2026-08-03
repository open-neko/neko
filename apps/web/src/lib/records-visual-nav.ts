export const RECORDS_VISUAL_NAV_APPS = [
  {
    appId: "crm",
    label: "CRM",
    purpose: "Customer relationships and pipeline",
    objects: [
      { apiName: "account", label: "Account", pluralLabel: "Accounts", recordCount: "12,408", custom: false },
      { apiName: "contact", label: "Contact", pluralLabel: "Contacts", recordCount: "48,112", custom: false },
      { apiName: "opportunity", label: "Opportunity", pluralLabel: "Opportunities", recordCount: "1,290", custom: false },
      { apiName: "lead", label: "Lead", pluralLabel: "Leads", recordCount: "3,204", custom: false },
      { apiName: "case", label: "Case", pluralLabel: "Cases", recordCount: "9,876", custom: false },
      { apiName: "project__c", label: "Project", pluralLabel: "Projects", recordCount: "742", custom: true },
      { apiName: "field_visit__c", label: "Field visit", pluralLabel: "Field Visits", recordCount: "12,038", custom: true },
    ],
  },
  {
    appId: "support_lab",
    label: "Support Lab",
    purpose: "Adversarial renderer fixture",
    objects: [
      {
        apiName: "support_case",
        label: "Support case",
        pluralLabel: "Customer support requests requiring coordinated investigation",
        recordCount: "1",
        custom: true,
      },
    ],
  },
] as const;
