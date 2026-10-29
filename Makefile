SCHEMA := schemas/org.gnome.shell.extensions.gitlab-tasks.gschema.xml
DIST_DIR := dist

.PHONY: validate pack

validate:
	glib-compile-schemas --strict --dry-run schemas

pack: validate
	mkdir -p $(DIST_DIR)
	gnome-extensions pack --force --schema=$(SCHEMA) --out-dir=$(DIST_DIR) .
