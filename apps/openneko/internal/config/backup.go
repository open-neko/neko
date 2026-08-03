package config

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
)

const backupKeyFilename = "backup-key"

// BackupCipherPassword returns the per-install pgBackRest/config-snapshot
// encryption key. It lives on the host, outside every volume included in a
// backup, so losing the deployment does not also lose the key needed to
// restore it.
func BackupCipherPassword(overrideDir string) (string, error) {
	path := filepath.Join(Dir(overrideDir), backupKeyFilename)
	raw, err := os.ReadFile(path)
	if err == nil {
		value := strings.TrimSpace(string(raw))
		if len(value) < 32 {
			return "", fmt.Errorf("backup key %s is empty or too short", path)
		}
		if err := os.Chmod(path, 0o600); err != nil {
			return "", err
		}
		return value, nil
	}
	if !errors.Is(err, fs.ErrNotExist) {
		return "", err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return "", err
	}
	fresh := make([]byte, 32)
	if _, err := rand.Read(fresh); err != nil {
		return "", err
	}
	value := hex.EncodeToString(fresh)
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if errors.Is(err, fs.ErrExist) {
		return BackupCipherPassword(overrideDir)
	}
	if err != nil {
		return "", err
	}
	if _, err := file.WriteString(value + "\n"); err != nil {
		_ = file.Close()
		return "", err
	}
	if err := file.Close(); err != nil {
		return "", err
	}
	return value, nil
}
