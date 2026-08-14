package cli

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/open-neko/neko/apps/openneko/assets"
	"github.com/open-neko/neko/apps/openneko/internal/compose"
	"github.com/open-neko/neko/apps/openneko/internal/config"
	"github.com/open-neko/neko/apps/openneko/internal/version"
)

const (
	backupRepositoryIdentityVersion = 1
	backupKeyContainerPath          = "/run/secrets/openneko-backup-key"
)

type backupRepositoryIdentity struct {
	Version        int    `json:"version"`
	ID             string `json:"id"`
	KeyFingerprint string `json:"key_fingerprint"`
	RepositoryPath string `json:"repository_path"`
}

type repositoryContents int

const (
	repositoryEmpty repositoryContents = iota
	repositoryBackupData
	repositoryUnknownData
)

var backupRepositoryKeyValidator = validateBackupRepositoryKeyWithDocker

// configureBackupEnvironment binds a durable key to the backup repository.
// The key is passed to containers as a read-only file, never through Compose's
// environment where it would be visible in container inspection output.
func configureBackupEnvironment(projectNames ...string) error {
	repository, err := resolveBackupRepository(projectNames...)
	if err != nil {
		return err
	}
	keyPath, err := resolveBackupRepositoryKey(context.Background(), repository)
	if err != nil {
		return err
	}
	if err := os.Setenv("OPENNEKO_BACKUP_KEY_FILE", keyPath); err != nil {
		return err
	}
	// A legacy override may have supplied the value for a first-time migration.
	// Remove it before Docker Compose is invoked so it is not persisted in a
	// container's environment metadata.
	_ = os.Unsetenv("OPENNEKO_BACKUP_CIPHER_PASS")

	if os.Getenv("OPENNEKO_HOST_CONFIG_DIR") == "" {
		hostConfig, err := filepath.Abs(config.Dir(""))
		if err != nil {
			return err
		}
		if err := os.MkdirAll(hostConfig, 0o700); err != nil {
			return err
		}
		if err := os.Setenv("OPENNEKO_HOST_CONFIG_DIR", hostConfig); err != nil {
			return err
		}
	}
	return nil
}

func resolveBackupRepository(projectNames ...string) (string, error) {
	repository := os.Getenv("OPENNEKO_BACKUP_REPOSITORY")
	if repository == "" {
		sup := compose.New(assets.ComposeFS)
		project := ""
		if len(projectNames) > 0 {
			project = strings.TrimSpace(projectNames[0])
		}
		if project == "" {
			var err error
			project, err = sup.ProjectName("")
			if err != nil {
				return "", err
			}
		}
		if project == "" || strings.ContainsAny(project, `/\\`) || project == "." || project == ".." {
			return "", fmt.Errorf("invalid OpenNeko project name %q", project)
		}
		installationID, err := sup.InstallationID()
		if err != nil {
			return "", err
		}
		base := os.Getenv("XDG_DATA_HOME")
		if base == "" {
			home, err := os.UserHomeDir()
			if err != nil {
				return "", err
			}
			base = filepath.Join(home, ".local", "share")
		}
		repository = filepath.Join(base, "openneko", "repositories", installationID, project)
	}
	absolute, err := filepath.Abs(repository)
	if err != nil {
		return "", err
	}
	if err := os.MkdirAll(absolute, 0o700); err != nil {
		return "", err
	}
	if err := os.Setenv("OPENNEKO_BACKUP_REPOSITORY", absolute); err != nil {
		return "", err
	}
	return absolute, nil
}

func resolveBackupRepositoryKey(ctx context.Context, repository string) (string, error) {
	identity, err := readBackupRepositoryIdentity(repository)
	if err != nil && !errors.Is(err, fs.ErrNotExist) {
		return "", err
	}
	if identity != nil {
		return resolveIdentifiedRepositoryKey(repository, *identity)
	}

	contents, err := classifyBackupRepository(repository)
	if err != nil {
		if errors.Is(err, fs.ErrPermission) {
			// Rootful Docker releases before repository-bound state could chown
			// the bind mount to the container's postgres UID. Docker can still
			// validate it read-only even when the rootless CLI cannot traverse it.
			contents = repositoryBackupData
		} else {
			return "", err
		}
	}
	if contents == repositoryUnknownData {
		return "", fmt.Errorf("backup repository %s contains unrecognized data and has no OpenNeko identity; choose an empty repository or move the unrelated files", repository)
	}
	if contents == repositoryBackupData {
		legacyPath, err := legacyBackupKeyCandidate()
		if err != nil {
			return "", err
		}
		if _, readErr := config.ReadBackupKey(legacyPath); readErr != nil {
			return "", legacyRepositoryAdoptionError(repository, readErr)
		}
		if err := backupRepositoryKeyValidator(ctx, repository, legacyPath); err != nil {
			return "", legacyRepositoryAdoptionError(repository, err)
		}
		return adoptValidatedBackupRepositoryKey(repository, legacyPath)
	}

	value := strings.TrimSpace(os.Getenv("OPENNEKO_BACKUP_CIPHER_PASS"))
	if value != "" && (len(value) < 32 || strings.ContainsAny(value, "\r\n")) {
		return "", fmt.Errorf("OPENNEKO_BACKUP_CIPHER_PASS is empty, too short, or contains a newline")
	}
	repositoryID, err := newBackupRepositoryID()
	if err != nil {
		return "", err
	}
	identity = &backupRepositoryIdentity{Version: backupRepositoryIdentityVersion, ID: repositoryID}
	keyPath, err := backupRepositoryKeyPath(identity.ID)
	if err != nil {
		return "", err
	}
	if value == "" {
		if explicit := os.Getenv("OPENNEKO_BACKUP_KEY_FILE"); explicit != "" {
			explicit, err = filepath.Abs(explicit)
			if err != nil {
				return "", err
			}
			value, err = config.ReadBackupKey(explicit)
			if err != nil {
				return "", err
			}
			if err := persistBackupKey(keyPath, value); err != nil {
				return "", err
			}
		} else {
			value, err = config.CreateBackupKey(keyPath)
			if err != nil {
				return "", err
			}
		}
	} else if err := persistBackupKey(keyPath, value); err != nil {
		return "", err
	}
	identity.KeyFingerprint = backupKeyFingerprint(value)
	if err := writeBackupRepositoryIdentity(repository, *identity); err != nil {
		if errors.Is(err, fs.ErrExist) {
			return resolveBackupRepositoryKey(ctx, repository)
		}
		return "", err
	}
	return keyPath, nil
}

func legacyBackupKeyCandidate() (string, error) {
	if explicit := os.Getenv("OPENNEKO_BACKUP_KEY_FILE"); explicit != "" {
		return filepath.Abs(explicit)
	}
	return config.LegacyBackupKeyPath(""), nil
}

func resolveIdentifiedRepositoryKey(repository string, identity backupRepositoryIdentity) (string, error) {
	if err := validateBackupRepositoryIdentity(identity); err != nil {
		return "", fmt.Errorf("backup repository %s identity is invalid: %w", repository, err)
	}
	keyPath, err := backupRepositoryKeyPath(identity.ID)
	if err != nil {
		return "", err
	}

	candidates := []string{}
	explicitCandidate := ""
	if explicit := os.Getenv("OPENNEKO_BACKUP_KEY_FILE"); explicit != "" {
		absolute, absErr := filepath.Abs(explicit)
		if absErr != nil {
			return "", absErr
		}
		explicitCandidate = absolute
		candidates = append(candidates, absolute)
	}
	candidates = append(candidates, keyPath, config.LegacyBackupKeyPath(""))
	seen := map[string]bool{}
	for _, candidate := range candidates {
		if seen[candidate] {
			continue
		}
		seen[candidate] = true
		value, readErr := config.ReadBackupKey(candidate)
		if errors.Is(readErr, fs.ErrNotExist) {
			continue
		}
		if readErr != nil {
			return "", readErr
		}
		if backupKeyFingerprint(value) != identity.KeyFingerprint {
			if candidate == explicitCandidate {
				return "", fmt.Errorf("backup key %s does not match repository %s; the repository was not modified", candidate, repository)
			}
			continue
		}
		if candidate != keyPath {
			if err := persistBackupKey(keyPath, value); err != nil {
				return "", err
			}
		}
		return keyPath, nil
	}
	return "", fmt.Errorf("backup key for repository %s is missing; run `openneko backup key adopt --from <exported-key-file>`", repository)
}

func adoptValidatedBackupRepositoryKey(repository, source string) (string, error) {
	value, err := config.ReadBackupKey(source)
	if err != nil {
		return "", err
	}
	repositoryID, err := newBackupRepositoryID()
	if err != nil {
		return "", err
	}
	identity := backupRepositoryIdentity{
		Version:        backupRepositoryIdentityVersion,
		ID:             repositoryID,
		KeyFingerprint: backupKeyFingerprint(value),
	}
	keyPath, err := backupRepositoryKeyPath(identity.ID)
	if err != nil {
		return "", err
	}
	if err := persistBackupKey(keyPath, value); err != nil {
		return "", err
	}
	if err := writeBackupRepositoryIdentity(repository, identity); err != nil {
		return "", err
	}
	return keyPath, nil
}

func persistBackupKey(path, value string) error {
	if existing, err := config.ReadBackupKey(path); err == nil {
		if existing != value {
			return fmt.Errorf("refusing to replace existing repository key %s", path)
		}
		return nil
	} else if !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	return config.WriteBackupKey(path, value)
}

func backupRepositoryKeyPath(repositoryID string) (string, error) {
	root := os.Getenv("OPENNEKO_BACKUP_KEY_DIR")
	if root == "" {
		stateRoot, err := backupStateDirectory()
		if err != nil {
			return "", err
		}
		root = filepath.Join(stateRoot, "backup-keys")
	}
	absolute, err := filepath.Abs(root)
	if err != nil {
		return "", err
	}
	if err := os.MkdirAll(absolute, 0o700); err != nil {
		return "", err
	}
	if err := os.Chmod(absolute, 0o700); err != nil {
		return "", err
	}
	return filepath.Join(absolute, repositoryID+".key"), nil
}

func backupStateDirectory() (string, error) {
	root := os.Getenv("OPENNEKO_BACKUP_STATE_DIR")
	if root == "" {
		stateHome := os.Getenv("XDG_STATE_HOME")
		if stateHome == "" {
			home, err := os.UserHomeDir()
			if err != nil {
				return "", err
			}
			stateHome = filepath.Join(home, ".local", "state")
		}
		root = filepath.Join(stateHome, "openneko")
	}
	absolute, err := filepath.Abs(root)
	if err != nil {
		return "", err
	}
	if err := os.MkdirAll(absolute, 0o700); err != nil {
		return "", err
	}
	if err := os.Chmod(absolute, 0o700); err != nil {
		return "", err
	}
	return absolute, nil
}

func newBackupRepositoryID() (string, error) {
	raw := make([]byte, 16)
	if _, err := rand.Read(raw); err != nil {
		return "", fmt.Errorf("generate backup repository identity: %w", err)
	}
	return hex.EncodeToString(raw), nil
}

func backupKeyFingerprint(value string) string {
	digest := sha256.Sum256([]byte(value))
	return "sha256:" + hex.EncodeToString(digest[:])
}

func backupRepositoryIdentityFile(repository string) (string, error) {
	canonical, err := filepath.EvalSymlinks(repository)
	if err != nil {
		return "", err
	}
	canonical, err = filepath.Abs(canonical)
	if err != nil {
		return "", err
	}
	digest := sha256.Sum256([]byte("file:" + canonical))
	stateRoot, err := backupStateDirectory()
	if err != nil {
		return "", err
	}
	return filepath.Join(stateRoot, "repository-identities", hex.EncodeToString(digest[:])+".json"), nil
}

func readBackupRepositoryIdentity(repository string) (*backupRepositoryIdentity, error) {
	path, err := backupRepositoryIdentityFile(repository)
	if err != nil {
		return nil, err
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var identity backupRepositoryIdentity
	if err := json.Unmarshal(raw, &identity); err != nil {
		return nil, err
	}
	canonical, err := filepath.EvalSymlinks(repository)
	if err != nil {
		return nil, err
	}
	canonical, err = filepath.Abs(canonical)
	if err != nil {
		return nil, err
	}
	if identity.RepositoryPath != canonical {
		return nil, fmt.Errorf("backup repository identity path is %q, want %q", identity.RepositoryPath, canonical)
	}
	return &identity, nil
}

func validateBackupRepositoryIdentity(identity backupRepositoryIdentity) error {
	if identity.Version != backupRepositoryIdentityVersion {
		return fmt.Errorf("unsupported version %d", identity.Version)
	}
	if len(identity.ID) != 32 {
		return fmt.Errorf("invalid repository id")
	}
	if _, err := hex.DecodeString(identity.ID); err != nil {
		return fmt.Errorf("invalid repository id")
	}
	if len(identity.KeyFingerprint) != len("sha256:")+sha256.Size*2 || !strings.HasPrefix(identity.KeyFingerprint, "sha256:") {
		return fmt.Errorf("invalid key fingerprint")
	}
	if _, err := hex.DecodeString(strings.TrimPrefix(identity.KeyFingerprint, "sha256:")); err != nil {
		return fmt.Errorf("invalid key fingerprint")
	}
	if !filepath.IsAbs(identity.RepositoryPath) {
		return fmt.Errorf("invalid repository path")
	}
	return nil
}

func writeBackupRepositoryIdentity(repository string, identity backupRepositoryIdentity) error {
	canonical, err := filepath.EvalSymlinks(repository)
	if err != nil {
		return err
	}
	canonical, err = filepath.Abs(canonical)
	if err != nil {
		return err
	}
	identity.RepositoryPath = canonical
	if err := validateBackupRepositoryIdentity(identity); err != nil {
		return err
	}
	path, err := backupRepositoryIdentityFile(repository)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	raw, err := json.MarshalIndent(identity, "", "  ")
	if err != nil {
		return err
	}
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return err
	}
	raw = append(raw, '\n')
	if _, err := file.Write(raw); err != nil {
		_ = file.Close()
		_ = os.Remove(path)
		return err
	}
	if err := file.Sync(); err != nil {
		_ = file.Close()
		_ = os.Remove(path)
		return err
	}
	if err := file.Close(); err != nil {
		_ = os.Remove(path)
		return err
	}
	return nil
}

func classifyBackupRepository(repository string) (repositoryContents, error) {
	entries, err := os.ReadDir(repository)
	if err != nil {
		return repositoryEmpty, err
	}
	if len(entries) == 0 {
		return repositoryEmpty, nil
	}
	for _, relative := range []string{
		"backup/openneko-metadata/backup.info",
		"backup/openneko-records/backup.info",
		"archive/openneko-metadata/archive.info",
		"archive/openneko-records/archive.info",
		"openneko/latest",
	} {
		if _, statErr := os.Stat(filepath.Join(repository, filepath.FromSlash(relative))); statErr == nil {
			return repositoryBackupData, nil
		} else if !errors.Is(statErr, fs.ErrNotExist) {
			return repositoryEmpty, statErr
		}
	}
	// An identity directory left behind by an interrupted first start does not
	// turn an otherwise empty repository into an unrelated-data repository.
	if len(entries) == 1 && entries[0].Name() == "openneko" {
		children, readErr := os.ReadDir(filepath.Join(repository, "openneko"))
		if readErr == nil && len(children) == 0 {
			return repositoryEmpty, nil
		}
	}
	return repositoryUnknownData, nil
}

func legacyRepositoryAdoptionError(repository string, cause error) error {
	return fmt.Errorf("existing encrypted backup repository %s has no key identity and its candidate key could not be validated: %v; run `openneko backup key adopt --from <original-key-file>` (the repository was not modified)", repository, cause)
}

func validateBackupRepositoryKeyWithDocker(ctx context.Context, repository, keyPath string) error {
	image, err := backupValidationImage()
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()
	script := `
key=$(cat /run/secrets/openneko-backup-key)
cfg=/tmp/pgbackrest.conf
umask 077
printf '[global]\nrepo1-path=/var/lib/pgbackrest\nrepo1-cipher-type=aes-256-cbc\nrepo1-cipher-pass=%s\n' "$key" > "$cfg"
for stanza in openneko-metadata openneko-records; do
  pgbackrest --config="$cfg" --allow-root --stanza="$stanza" --output=json info >/dev/null
done
`
	args := []string{
		"run", "--rm", "--network", "none", "--read-only",
		"--tmpfs", "/tmp:rw,noexec,nosuid,size=1m",
		"--mount", "type=bind,src=" + repository + ",dst=/var/lib/pgbackrest,readonly",
		"--mount", "type=bind,src=" + keyPath + ",dst=" + backupKeyContainerPath + ",readonly",
		"--entrypoint", "/bin/sh", image, "-ceu", script,
	}
	cmd := exec.CommandContext(ctx, "docker", args...)
	var output bytes.Buffer
	cmd.Stdout = &output
	cmd.Stderr = &output
	if err := cmd.Run(); err != nil {
		detail := strings.TrimSpace(output.String())
		if len(detail) > 1200 {
			detail = detail[len(detail)-1200:]
		}
		if detail != "" {
			return fmt.Errorf("pgBackRest rejected the key: %s", detail)
		}
		return fmt.Errorf("pgBackRest rejected the key: %w", err)
	}
	return nil
}

func backupValidationImage() (string, error) {
	imageVersion := os.Getenv("OPENNEKO_VERSION")
	if imageVersion != "" {
		return "ghcr.io/open-neko/neko-backup:" + imageVersion, nil
	}
	sup := compose.New(assets.ComposeFS)
	if project, err := sup.ProjectName(""); err == nil {
		args := []string{
			"ps", "-a",
			"--filter", "label=com.docker.compose.project=" + project,
			"--filter", "label=com.docker.compose.service=neko-backup",
			"--format", "{{.Image}}",
		}
		if raw, runErr := exec.Command("docker", args...).Output(); runErr == nil {
			if runningImage := strings.TrimSpace(strings.SplitN(string(raw), "\n", 2)[0]); runningImage != "" {
				return runningImage, nil
			}
		}
	}
	imageVersion, err := sup.ImageVersion()
	if err != nil {
		return "", err
	}
	if imageVersion == "" {
		imageVersion = "v" + version.Version
	}
	return "ghcr.io/open-neko/neko-backup:" + imageVersion, nil
}

func backupFailureDomainWarning() string {
	if os.Getenv("OPENNEKO_BACKUP_FAILURE_DOMAIN_ACK") == "1" {
		return ""
	}
	return fmt.Sprintf(
		"backup repository %s is a host path; mount it from a NAS or other failure domain, then set OPENNEKO_BACKUP_FAILURE_DOMAIN_ACK=1",
		os.Getenv("OPENNEKO_BACKUP_REPOSITORY"),
	)
}
