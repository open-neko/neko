package cli

import (
	"strings"
	"testing"
	"time"
)

func TestStorageDoctorLevelCombinesPercentAndAbsoluteThresholds(t *testing.T) {
	tests := []struct {
		capacity storageCapacity
		want     string
	}{
		{storageCapacity{FreeBytes: 10 << 30, UsedPercent: 20}, "ok"},
		{storageCapacity{FreeBytes: 4 << 30, UsedPercent: 20}, "warning"},
		{storageCapacity{FreeBytes: 10 << 30, UsedPercent: 91}, "critical"},
		{storageCapacity{FreeBytes: 512 << 20, UsedPercent: 20}, "hard stop"},
	}
	for _, test := range tests {
		if got := storageDoctorLevel(test.capacity); got != test.want {
			t.Fatalf("storageDoctorLevel(%+v) = %q, want %q", test.capacity, got, test.want)
		}
	}
}

func TestBackupDoctorHealthRequiresFreshBackupAndVerification(t *testing.T) {
	now := time.Date(2026, 8, 2, 20, 0, 0, 0, time.UTC)
	status := backupDoctorStatus{
		State:                  "ready",
		LastBackupAt:           now.Add(-2 * time.Hour).Format(time.RFC3339),
		LastVerificationAt:     now.Add(-6 * 24 * time.Hour).Format(time.RFC3339),
		LastVerificationStatus: "succeeded",
	}
	if ok, _ := backupDoctorHealth(status, now); !ok {
		t.Fatal("expected fresh backup and verification to pass")
	}
	status.LastVerificationAt = now.Add(-9 * 24 * time.Hour).Format(time.RFC3339)
	if ok, detail := backupDoctorHealth(status, now); ok || !strings.Contains(detail, "stale") {
		t.Fatalf("expected stale verification failure, got ok=%v detail=%q", ok, detail)
	}
}

func TestBackupRestoreProtectionRequiresLatestCompleteBackupSet(t *testing.T) {
	now := time.Date(2026, 8, 2, 20, 0, 0, 0, time.UTC)
	status := backupDoctorStatus{
		State:                  "ready",
		LastBackupAt:           now.Add(-2 * time.Hour).Format(time.RFC3339),
		LastBackupSet:          "set-current",
		LastVerificationAt:     now.Add(-time.Hour).Format(time.RFC3339),
		LastVerificationStatus: "succeeded",
	}
	status.Verification.Status = "succeeded"
	status.Verification.BackupSet = "set-current"
	status.Verification.ConfigSnapshot.Status = "decrypted_and_checksum_verified"
	status.Verification.Databases = append(status.Verification.Databases,
		struct {
			Stanza string `json:"stanza"`
		}{Stanza: "openneko-metadata"},
		struct {
			Stanza string `json:"stanza"`
		}{Stanza: "openneko-records"},
	)

	if ok, detail := backupRestoreProtection(status, now); !ok {
		t.Fatalf("expected complete current backup set to pass: %s", detail)
	}
	status.Verification.BackupSet = "set-older"
	if ok, detail := backupRestoreProtection(status, now); ok || !strings.Contains(detail, "latest") {
		t.Fatalf("expected stale set failure, got ok=%v detail=%q", ok, detail)
	}
}
