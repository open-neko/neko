import { describe, expect, it } from "vitest";
import {
  normalizeSalesforceId,
  SalesforceIdError,
} from "../src/connect/salesforce/id";

describe("Salesforce identifiers", () => {
  it("canonicalizes 15-character ids and preserves valid 18-character ids", () => {
    expect(normalizeSalesforceId("001A000010khO8J")).toBe("001A000010khO8JIAU");
    expect(normalizeSalesforceId("001A000010khO8JIAU")).toBe(
      "001A000010khO8JIAU",
    );
  });

  it("rejects malformed and checksum-invalid ids", () => {
    expect(() => normalizeSalesforceId("001A000010khO8JAAA")).toThrow(
      SalesforceIdError,
    );
    expect(() => normalizeSalesforceId("not-an-id")).toThrow(SalesforceIdError);
  });
});
