//go:build integration

package cli

import (
	"bytes"
	"context"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/testcontainers/testcontainers-go"
	"github.com/testcontainers/testcontainers-go/modules/postgres"
	"github.com/testcontainers/testcontainers-go/wait"

	"github.com/open-neko/neko/apps/openneko/internal/config"
)

func TestMigrateOpenShellRoleCredentialContract(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()

	pg, err := postgres.Run(ctx,
		"pgvector/pgvector:pg16",
		postgres.WithDatabase("neko"),
		postgres.WithUsername("neko"),
		postgres.WithPassword("secret"),
		testcontainers.WithWaitStrategy(
			wait.ForLog("database system is ready to accept connections").
				WithOccurrence(2).
				WithStartupTimeout(2*time.Minute),
		),
	)
	if err != nil {
		t.Fatalf("postgres container: %v", err)
	}
	t.Cleanup(func() { _ = pg.Terminate(context.Background()) })

	host, err := pg.Host(ctx)
	if err != nil {
		t.Fatal(err)
	}
	port, err := pg.MappedPort(ctx, "5432/tcp")
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	t.Setenv("NEKO_PG_HOST", host)
	t.Setenv("NEKO_PG_PORT", port.Port())
	t.Setenv("NEKO_PG_USER", "neko")
	t.Setenv("NEKO_PG_PASSWORD", "secret")
	t.Setenv("NEKO_PG_DATABASE", "neko")
	t.Setenv(openShellDBPasswordEnv, "private-container-password")

	cmd := newMigrateCmd()
	cmd.SetArgs([]string{"--skip-schema"})
	var out bytes.Buffer
	cmd.SetOut(&out)
	cmd.SetErr(&out)
	if err := cmd.ExecuteContext(ctx); err != nil {
		t.Fatalf("migrate --skip-schema: %v\n%s", err, out.String())
	}
	if !strings.Contains(out.String(), "schema migrations skipped") ||
		!strings.Contains(out.String(), "OpenShell database role ready") {
		t.Fatalf("unexpected output: %s", out.String())
	}

	dsn := func(password string) string {
		return "postgres://openshell:" + password + "@" + host + ":" +
			port.Port() + "/neko?sslmode=disable"
	}
	conn, err := pgx.Connect(ctx, dsn("private-container-password"))
	if err != nil {
		t.Fatalf("connect as provisioned role: %v", err)
	}
	var member bool
	if err := conn.QueryRow(ctx, "SELECT pg_has_role(current_user, 'neko', 'member')").Scan(&member); err != nil {
		t.Fatal(err)
	}
	if !member {
		t.Fatal("openshell role is not a member of neko")
	}
	if err := conn.Close(ctx); err != nil {
		t.Fatal(err)
	}

	// Reproduce the dangerous lifecycle: an existing gateway uses the explicit
	// credential above, while a separately launched migration container sees a
	// different config volume and no propagated password. It must fail before
	// ALTER ROLE instead of replacing the gateway's working credential.
	containerConfigHome := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", containerConfigHome)
	t.Setenv(openShellDBPasswordEnv, "")
	t.Setenv(requireExplicitOpenShellDBPasswordEnv, "1")

	refused := newMigrateCmd()
	refused.SetArgs([]string{"--skip-schema"})
	var refusedOut bytes.Buffer
	refused.SetOut(&refusedOut)
	refused.SetErr(&refusedOut)
	err = refused.ExecuteContext(ctx)
	if err == nil || !strings.Contains(err.Error(), openShellDBPasswordEnv) ||
		!strings.Contains(err.Error(), "refusing") {
		t.Fatalf("missing credential error = %v, want fail-closed refusal\n%s", err, refusedOut.String())
	}
	if strings.Contains(refusedOut.String(), "OpenShell database role ready") {
		t.Fatalf("refused migration reported role readiness: %s", refusedOut.String())
	}

	// The original gateway credential still authenticates after the refusal.
	conn, err = pgx.Connect(ctx, dsn("private-container-password"))
	if err != nil {
		t.Fatalf("original gateway credential was changed: %v", err)
	}
	if err := conn.Close(ctx); err != nil {
		t.Fatal(err)
	}

	// And the password that the old fallback would have derived from the
	// container-local key was not installed on the database role.
	containerPassword, err := config.OpenShellDBPassword("")
	if err != nil {
		t.Fatal(err)
	}
	wrongConn, wrongErr := pgx.Connect(ctx, dsn(containerPassword))
	if wrongErr == nil {
		_ = wrongConn.Close(ctx)
		t.Fatal("container-local fallback credential unexpectedly authenticates")
	}
}
