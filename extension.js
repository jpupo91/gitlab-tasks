import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';
import Pango from 'gi://Pango';
import Soup from 'gi://Soup';
import St from 'gi://St';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as ModalDialog from 'resource:///org/gnome/shell/ui/modalDialog.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

const DEFAULT_INTERVAL = 300;
const MAX_PROJECTS = 100;
const MAX_ITEMS = 10;
const MAX_CONCURRENT_PROJECT_REQUESTS = 5;

function escapeMarkup(text) {
    return text
        .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

function formatInlineMarkdown(text) {
    const preserved = [];
    const preserve = markup => {
        const key = `\u0001${preserved.length}\u0002`;
        preserved.push(markup);
        return key;
    };
    let markup = escapeMarkup(text);

    markup = markup.replace(/`([^`\n]+)`/g, (_match, code) =>
        preserve(`<tt>${code}</tt>`));
    markup = markup.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, (_match, label, url) =>
        preserve(`<a href="${url}"><u>${formatInlineMarkdown(label)}</u></a>`));
    markup = markup.replace(/\*\*(.+?)\*\*|__(.+?)__/g, (_match, a, b) =>
        `<b>${a ?? b}</b>`);
    markup = markup.replace(/~~(.+?)~~/g, '<s>$1</s>');
    markup = markup.replace(/\*([^*\n]+)\*/g, '<i>$1</i>');

    return markup.replace(/\u0001(\d+)\u0002/g, (_match, index) => preserved[index]);
}

function formatMarkdown(markdown) {
    const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
    const output = [];
    let paragraph = [];

    const flushParagraph = () => {
        if (paragraph.length > 0) {
            output.push(formatInlineMarkdown(paragraph.join('\n')));
            paragraph = [];
        }
    };

    for (let index = 0; index < lines.length; index++) {
        const line = lines[index];
        const fence = line.match(/^\s*(```+|~~~+)/);
        if (fence) {
            flushParagraph();
            const code = [];
            const closingFence = new RegExp(`^\\s*${fence[1][0]}{${fence[1].length},}\\s*$`);
            index++;
            while (index < lines.length && !closingFence.test(lines[index]))
                code.push(lines[index++]);
            output.push(`<tt>${escapeMarkup(code.join('\n'))}</tt>`);
            continue;
        }

        if (!line.trim()) {
            flushParagraph();
            if (output.at(-1) !== '')
                output.push('');
            continue;
        }

        const heading = line.match(/^ {0,3}(#{1,6})\s+(.+?)\s*#*\s*$/);
        if (heading) {
            flushParagraph();
            output.push(`<big><b>${formatInlineMarkdown(heading[2])}</b></big>`);
            continue;
        }

        const listItem = line.match(/^\s*(?:([-+*])|(\d+)[.)])\s+(.+)$/);
        if (listItem) {
            flushParagraph();
            const marker = listItem[2] ? `${listItem[2]}.` : '•';
            output.push(`${marker} ${formatInlineMarkdown(listItem[3])}`);
            continue;
        }

        const quote = line.match(/^ {0,3}>\s?(.*)$/);
        if (quote) {
            flushParagraph();
            output.push(`<i>${formatInlineMarkdown(quote[1])}</i>`);
            continue;
        }

        paragraph.push(line);
    }

    flushParagraph();
    return output.join('\n');
}

export default class GitLabTasksExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._session = new Soup.Session();
        this._button = new PanelMenu.Button(0.0, this.metadata.name, false);
        this._button.add_child(new St.Icon({
            icon_name: 'view-list-symbolic',
            style_class: 'system-status-icon',
        }));
        Main.panel.addToStatusArea(this.uuid, this._button);

        this._knownIssues = null;
        this._knownDeployments = null;
        this._issues = [];
        this._deployments = [];
        this._collapsedIssueProjects = new Set();
        this._collapsedDeploymentProjects = new Set();
        this._projects = [];
        this._dataError = null;
        this._deploymentLoadErrors = [];
        this._jobActionsInProgress = new Set();
        this._labelColors = new Map();
        this._dataDialogClosing = false;
        this._refreshAfterPoll = false;
        this._selectedLabel = null;
        this._groupByLabel = false;
        this._groupByProject = false;
        this._polling = false;
        this._settingsChangedId = this._settings.connect('changed', () => {
            this._restartTimer();
        });
        this._rebuildMenu('Conectando a GitLab…');
        this._restartTimer();
        this._poll();
    }

    disable() {
        if (this._timerId) {
            GLib.Source.remove(this._timerId);
            this._timerId = 0;
        }
        if (this._settingsChangedId) {
            this._settings.disconnect(this._settingsChangedId);
            this._settingsChangedId = 0;
        }
        this._session?.abort();
        this._session = null;
        this._dataDialog?.close();
        this._dataDialog = null;
        this._button?.destroy();
        this._button = null;
        this._settings = null;
    }

    _restartTimer() {
        if (this._timerId) {
            GLib.Source.remove(this._timerId);
        }
        const configuredInterval = this._settings.get_int('poll-interval');
        const interval = Math.max(60, configuredInterval || DEFAULT_INTERVAL);
        this._timerId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT,
            interval,
            () => {
                this._poll();
                return GLib.SOURCE_CONTINUE;
            }
        );
    }

    async _request(baseUrl, path, token, method = 'GET') {
        const message = Soup.Message.new(method, `${baseUrl}/api/v4${path}`);
        message.request_headers.append('PRIVATE-TOKEN', token);
        const bytes = await new Promise((resolve, reject) => {
            this._session.send_and_read_async(
                message,
                GLib.PRIORITY_DEFAULT,
                null,
                (session, result) => {
                    try {
                        resolve(session.send_and_read_finish(result));
                    } catch (error) {
                        reject(error);
                    }
                }
            );
        });

        const body = new TextDecoder().decode(bytes.get_data());
        if (message.get_status() < 200 || message.get_status() >= 300) {
            const permissionHint = message.get_status() === 403 && method === 'POST'
                ? ' Comprueba que el token tenga el alcance api y permiso para ejecutar jobs en este proyecto.'
                : '';
            throw new Error(
                `GitLab respondió ${message.get_status()} en ${path}.${permissionHint} ${body.slice(0, 200)}`
            );
        }
        return body ? JSON.parse(body) : null;
    }

    async _poll(refreshAfterCurrent = false) {
        if (!this._settings || !this._session)
            return;
        if (this._polling) {
            this._refreshAfterPoll ||= refreshAfterCurrent;
            return;
        }

        const baseUrl = this._settings.get_string('gitlab-url').trim().replace(/\/+$/, '');
        const token = this._settings.get_string('private-token').trim();
        if (!baseUrl || !token) {
            this._dataError = 'Configura la URL y el token en Preferencias';
            this._rebuildMenu(this._dataError);
            return;
        }
        this._polling = true;
        try {
            const [user, issues, projects] = await Promise.all([
                this._request(baseUrl, '/user', token),
                this._request(
                    baseUrl,
                    '/issues?scope=assigned_to_me&state=opened&per_page=100&order_by=updated_at&sort=desc',
                    token
                ),
                this._request(
                    baseUrl,
                    `/projects?membership=true&per_page=${MAX_PROJECTS}&order_by=last_activity_at&sort=desc`,
                    token
                ),
            ]);

            const labelColorsPromise = this._loadIssueLabelColors(baseUrl, token, issues);
            const issueIds = new Set(issues.map(issue => issue.id));
            const newIssues = this._knownIssues === null
                ? []
                : issues.filter(issue => !this._knownIssues.has(issue.id));
            this._knownIssues = issueIds;

            this._dataError = null;
            this._deploymentLoadErrors = [];
            this._labelColors = new Map();
            this._issues = issues;
            this._projects = projects;
            this._refreshDataDialog();
            for (const issue of newIssues) {
                Main.notify('Nueva tarea asignada', `${issue.references?.full ?? `#${issue.iid}`} · ${issue.title}`);
            }

            const deployments = [];
            const projectDeployments = new Array(projects.length);
            let nextProjectIndex = 0;
            const workerCount = Math.min(MAX_CONCURRENT_PROJECT_REQUESTS, projects.length);
            await Promise.all(Array.from({length: workerCount}, async () => {
                while (nextProjectIndex < projects.length) {
                    const index = nextProjectIndex++;
                    const project = projects[index];
                    const path = `/projects/${encodeURIComponent(project.id)}/deployments?status=success&order_by=updated_at&sort=desc&per_page=20`;
                    try {
                        projectDeployments[index] = await this._request(baseUrl, path, token);
                    } catch (error) {
                        this._deploymentLoadErrors.push(project.name_with_namespace);
                        console.error(`[${this.uuid}] No se pudieron consultar los deploys de ${project.name_with_namespace}: ${error.message}`);
                    }
                }
            }));
            for (let index = 0; index < projects.length; index++) {
                deployments.push(...(projectDeployments[index] ?? [])
                    .filter(deployment => deployment.user?.id === user.id)
                    .map(deployment => ({
                        ...deployment,
                        projectId: projects[index].id,
                        projectName: projects[index].name_with_namespace,
                        projectWebUrl: projects[index].web_url,
                    })));
            }

            this._labelColors = await labelColorsPromise;
            this._refreshDataDialog();

            const deploymentIds = new Set(deployments.map(
                deployment => `${deployment.projectId}:${deployment.id}`
            ));
            const newDeployments = this._knownDeployments === null
                ? []
                : deployments.filter(deployment =>
                    !this._knownDeployments.has(`${deployment.projectId}:${deployment.id}`)
                );
            this._knownDeployments = deploymentIds;
            const recentDeployments = deployments
                .sort((a, b) => Date.parse(b.updated_at ?? b.created_at) - Date.parse(a.updated_at ?? a.created_at))
                .slice(0, MAX_ITEMS);

            const pipelines = new Map();
            for (const deployment of recentDeployments) {
                const pipelineId = deployment.deployable?.pipeline?.id;
                if (!pipelineId) {
                    deployment.actionsError = 'No se pudo identificar el pipeline de este deploy.';
                    continue;
                }
                const key = `${deployment.projectId}:${pipelineId}`;
                if (!pipelines.has(key)) {
                    pipelines.set(key, {
                        projectId: deployment.projectId,
                        pipelineId,
                        deployments: [],
                    });
                }
                pipelines.get(key).deployments.push(deployment);
            }
            await Promise.all([...pipelines.values()].map(async pipeline => {
                const path = `/projects/${encodeURIComponent(pipeline.projectId)}/pipelines/${encodeURIComponent(pipeline.pipelineId)}/jobs?scope%5B%5D=manual&scope%5B%5D=failed&per_page=100`;
                try {
                    const jobs = await this._request(baseUrl, path, token);
                    for (const deployment of pipeline.deployments)
                        deployment.jobs = jobs;
                } catch (error) {
                    console.error(`[${this.uuid}] No se pudieron consultar los jobs del pipeline ${pipeline.pipelineId}: ${error.message}`);
                    for (const deployment of pipeline.deployments)
                        deployment.actionsError = error.message;
                }
            }));

            for (const deployment of newDeployments) {
                Main.notify('Deploy completado', `${deployment.projectName} · ${deployment.environment?.name ?? deployment.status}`);
            }

            this._deployments = recentDeployments;
            this._rebuildMenu(null);
        } catch (error) {
            console.error(`[${this.uuid}] No se pudieron actualizar los datos de GitLab: ${error.message}`);
            this._dataError = error.message;
            this._refreshDataDialog();
            this._rebuildMenu(`Error al consultar GitLab: ${error.message}`);
        } finally {
            this._polling = false;
            this._refreshDataDialog();
            if (this._refreshAfterPoll) {
                this._refreshAfterPoll = false;
                this._poll();
            }
        }
    }

    async _loadIssueLabelColors(baseUrl, token, issues) {
        const projectIds = [...new Set(issues
            .filter(issue => issue.labels?.length && issue.project_id !== null && issue.project_id !== undefined)
            .map(issue => issue.project_id))];
        const colorsByName = new Map();
        let nextProjectIndex = 0;
        const workerCount = Math.min(MAX_CONCURRENT_PROJECT_REQUESTS, projectIds.length);

        await Promise.all(Array.from({length: workerCount}, async () => {
            while (nextProjectIndex < projectIds.length) {
                const projectId = projectIds[nextProjectIndex++];
                try {
                    const labels = await this._request(
                        baseUrl,
                        `/projects/${encodeURIComponent(projectId)}/labels?per_page=100`,
                        token
                    );
                    if (!Array.isArray(labels))
                        throw new Error('La respuesta de etiquetas no tiene un formato válido.');

                    for (const label of labels) {
                        if (label.name && label.color && !colorsByName.has(label.name)) {
                            colorsByName.set(label.name, {
                                color: label.color,
                                textColor: label.text_color,
                            });
                        }
                    }
                } catch (error) {
                    console.error(`[${this.uuid}] No se pudieron consultar los colores de etiquetas del proyecto ${projectId}: ${error.message}`);
                }
            }
        }));

        return colorsByName;
    }

    _confirmJobAction(deployment, job, action) {
        const isPlay = action === 'play';
        const verb = isPlay ? 'ejecutar' : 'reintentar';
        const dialog = new ModalDialog.ModalDialog();
        dialog.contentLayout.add_child(new St.Label({
            text: `¿Quieres ${verb} el job "${job.name}" de ${deployment.projectName}? GitLab iniciará una ejecución en este pipeline.`,
            style_class: 'prompt-dialog-headline',
        }));
        dialog.setButtons([
            {
                label: 'Cancelar',
                action: () => dialog.close(),
                default: true,
            },
            {
                label: isPlay ? 'Ejecutar job' : 'Reintentar job',
                action: () => {
                    dialog.close();
                    this._runJobAction(deployment, job, action);
                },
            },
        ]);
        dialog.open();
    }

    async _runJobAction(deployment, job, action) {
        const actionKey = `${deployment.projectId}:${job.id}`;
        if (this._jobActionsInProgress.has(actionKey))
            return;
        this._jobActionsInProgress.add(actionKey);
        let refresh = false;
        const verb = action === 'play' ? 'ejecutar' : 'reintentar';
        try {
            const baseUrl = this._settings.get_string('gitlab-url').trim().replace(/\/+$/, '');
            const token = this._settings.get_string('private-token').trim();
            const jobPath = `/projects/${encodeURIComponent(deployment.projectId)}/jobs/${encodeURIComponent(job.id)}`;
            const currentJob = await this._request(baseUrl, jobPath, token);
            const expectedStatus = action === 'play' ? 'manual' : 'failed';
            if (currentJob.status !== expectedStatus) {
                throw new Error(`El job ya no está en estado "${expectedStatus}" (estado actual: ${currentJob.status}). Actualiza la extensión.`);
            }
            await this._request(baseUrl, `${jobPath}/${action}`, token, 'POST');
            Main.notify('Acción enviada a GitLab', `${job.name}: se solicitó ${verb}.`);
            refresh = true;
        } catch (error) {
            console.error(`[${this.uuid}] No se pudo ${verb} el job ${job.id}: ${error.message}`);
            Main.notify('No se pudo completar la acción', `${job.name}: ${error.message}`);
        } finally {
            this._jobActionsInProgress.delete(actionKey);
        }
        if (refresh)
            await this._poll(true);
    }

    _showIssueDetails(issue, projectName) {
        const dialog = new ModalDialog.ModalDialog();
        const scrollView = new St.ScrollView({
            overlay_scrollbars: false,
            style_class: 'gitlab-task-description-scroll',
        });
        scrollView.set_policy(Gtk.PolicyType.NEVER, Gtk.PolicyType.AUTOMATIC);
        scrollView.set_size(600, 440);

        const content = this._createVerticalBox('padding: 8px;', 10);
        const title = new St.Label({
            text: issue.title,
            style_class: 'heading',
            x_expand: true,
        });
        title.clutter_text.set_line_wrap(true);
        content.add_child(title);

        const metadata = [
            ['Proyecto', projectName],
            ['Estado', issue.state],
            ['Etiquetas', issue.labels?.join(', ')],
            ['Asignado a', issue.assignees?.map(assignee => assignee.name).join(', ')],
            ['Autor', issue.author?.name],
            ['Vencimiento', issue.due_date],
            ['Actualizada', issue.updated_at
                ? new Date(issue.updated_at).toLocaleString()
                : null],
        ].filter(([, value]) => value).map(([name, value]) => `${name}: ${value}`);
        if (metadata.length > 0) {
            const metadataLabel = new St.Label({
                text: metadata.join('\n'),
                style_class: 'dim-label',
                x_expand: true,
            });
            metadataLabel.clutter_text.set_line_wrap(true);
            content.add_child(metadataLabel);
        }

        content.add_child(new St.Label({
            text: 'Descripción',
            style_class: 'heading',
            x_expand: true,
        }));
        const description = new St.Label({
            text: '',
            style_class: 'gitlab-task-description',
            x_expand: true,
        });
        description.clutter_text.set_markup(formatMarkdown(
            issue.description?.trim() || 'Esta issue no tiene descripción.'
        ));
        description.clutter_text.set_line_wrap(true);
        description.clutter_text.set_selectable(true);
        content.add_child(description);
        scrollView.add_child(content);
        dialog.contentLayout.add_child(new St.Label({
            text: `Issue #${issue.iid}`,
            style_class: 'prompt-dialog-headline',
        }));
        dialog.contentLayout.add_child(scrollView);
        dialog.setButtons([{
            label: 'Cerrar',
            action: () => dialog.close(),
            default: true,
        }]);
        dialog.open();
    }

    _rebuildMenu(status) {
        if (!this._button)
            return;
        this._button.menu.removeAll();

        if (status) {
            const statusItem = new PopupMenu.PopupMenuItem(status, {reactive: false});
            this._button.menu.addMenuItem(statusItem);
        }

        this._button.menu.addAction('Abrir panel de GitLab Tasks', () => this._openDataDialog());
        this._button.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._button.menu.addAction('Preferencias', () => this.openPreferences());
        this._button.menu.addAction('Actualizar ahora', () => this._poll());
        this._refreshDataDialog();
    }

    _createVerticalBox(style = '', spacing = 8) {
        return new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            style: `spacing: ${spacing}px; ${style}`,
        });
    }

    _createHorizontalBox(spacing = 8) {
        return new St.BoxLayout({
            x_expand: true,
            style: `spacing: ${spacing}px;`,
        });
    }

    _createButton(label, callback, styleClass = 'button', style = '') {
        const button = new St.Button({
            label,
            style_class: styleClass,
            style,
            can_focus: true,
            reactive: true,
        });
        button.connect('clicked', callback);
        return button;
    }

    _openDataDialog() {
        if (this._dataDialogClosing)
            return;
        if (!this._dataDialog || !this._dataTabBar || !this._dataFilterBar || !this._dataContent) {
            if (this._dataDialog) {
                this._dataDialogClosing = true;
                this._dataDialog.close();
                this._dataDialog = null;
                this._dataDialogClosing = false;
            }

            const dialog = new ModalDialog.ModalDialog();
            const tabBar = this._createHorizontalBox();
            this._dataFilterScroll = new St.ScrollView({
                overlay_scrollbars: false,
                x_expand: true,
            });
            this._dataFilterScroll.set_policy(Gtk.PolicyType.AUTOMATIC, Gtk.PolicyType.NEVER);
            this._dataFilterScroll.set_size(760, 44);
            const filterBar = this._createHorizontalBox();
            filterBar.x_expand = false;
            this._dataFilterScroll.add_child(filterBar);
            this._dataContentScroll = new St.ScrollView({
                overlay_scrollbars: false,
                x_expand: true,
                y_expand: true,
            });
            this._dataContentScroll.set_policy(Gtk.PolicyType.NEVER, Gtk.PolicyType.AUTOMATIC);
            this._dataContentScroll.set_size(760, 500);
            const content = this._createVerticalBox('padding: 8px;', 12);
            content.y_expand = true;
            this._dataContentScroll.add_child(content);

            dialog.contentLayout.add_child(tabBar);
            dialog.contentLayout.add_child(this._dataFilterScroll);
            dialog.contentLayout.add_child(this._dataContentScroll);
            dialog.setButtons([{
                label: 'Cerrar',
                action: () => this._closeDataDialog(),
                default: true,
            }]);
            this._dataTab = 'issues';
            this._dataTabBar = tabBar;
            this._dataFilterBar = filterBar;
            this._dataContent = content;
            this._dataDialog = dialog;
            this._dataDialogClosing = false;
            dialog.connect('closed', () => {
                if (this._dataDialog !== dialog)
                    return;
                this._dataDialogClosing = true;
                this._dataTabBar = null;
                this._dataFilterScroll = null;
                this._dataFilterBar = null;
                this._dataContentScroll = null;
                this._dataContent = null;
                this._dataDialog = null;
                this._dataDialogClosing = false;
            });
        }

        this._refreshDataDialog();
        this._dataDialog.open();
    }

    _closeDataDialog() {
        if (!this._dataDialog)
            return;
        this._dataDialogClosing = true;
        this._dataDialog.close();
    }

    _setDataTab(tab) {
        this._dataTab = tab;
        this._refreshDataDialog();
    }

    _refreshDataDialog() {
        if (!this._dataDialog || this._dataDialogClosing ||
            !this._dataTabBar || !this._dataFilterBar || !this._dataContent)
            return;

        this._clearActor(this._dataTabBar);
        const tasksButton = this._createButton(
            `Tareas (${this._issues.length})`,
            () => this._setDataTab('issues'),
            this._dataTab === 'issues' ? 'button suggested-action' : 'button'
        );
        const deploymentsButton = this._createButton(
            `Deploys (${this._deployments.length})`,
            () => this._setDataTab('deployments'),
            this._dataTab === 'deployments' ? 'button suggested-action' : 'button'
        );
        this._dataTabBar.add_child(tasksButton);
        this._dataTabBar.add_child(deploymentsButton);

        this._clearActor(this._dataFilterBar);
        this._clearActor(this._dataContent);
        if (this._dataError) {
            const errorLabel = new St.Label({
                text: `No se pudieron cargar los datos: ${this._dataError}`,
                x_expand: true,
            });
            errorLabel.clutter_text.set_line_wrap(true);
            this._dataContent.add_child(errorLabel);
        }
        if (this._dataTab === 'issues') {
            this._buildIssueFilters(this._dataFilterBar);
            this._buildIssueList(this._dataContent, this._issues, this._projects);
        } else {
            this._buildDeploymentList(this._dataContent, this._deployments);
        }
    }

    _clearActor(actor) {
        let child = actor.get_first_child();
        while (child) {
            actor.remove_child(child);
            child = actor.get_first_child();
        }
    }

    _buildIssueFilters(container) {
        const labels = [...new Set(this._issues.flatMap(issue => issue.labels ?? []))]
            .sort((a, b) => a.localeCompare(b));
        if (this._selectedLabel !== null && !labels.includes(this._selectedLabel))
            this._selectedLabel = null;

        const allLabelsItem = this._createButton('Todas', () => {
            this._selectedLabel = null;
            this._refreshDataDialog();
        }, this._selectedLabel === null ? 'button suggested-action' : 'button');
        container.add_child(allLabelsItem);
        for (const label of labels) {
            const color = this._labelColors.get(label);
            const isSelected = this._selectedLabel === label;
            const hasColor = color && /^#[0-9a-f]{6}$/i.test(color.color);
            const onLabelSelected = () => {
                this._selectedLabel = label;
                this._refreshDataDialog();
            };
            const labelItem = hasColor
                ? this._createLabelButton(label, onLabelSelected, color, isSelected)
                : this._createButton(
                    label,
                    onLabelSelected,
                    isSelected ? 'button suggested-action' : 'button'
                );
            labelItem.x_expand = false;
            labelItem.get_child().clutter_text.set_ellipsize(Pango.EllipsizeMode.NONE);
            container.add_child(labelItem);
        }

        const groupItem = this._createButton(
            this._groupByLabel ? 'Agrupadas por etiqueta' : 'Agrupar por etiqueta',
            () => {
                this._groupByLabel = !this._groupByLabel;
                if (this._groupByLabel)
                    this._groupByProject = false;
                this._refreshDataDialog();
            },
            this._groupByLabel ? 'button suggested-action' : 'button'
        );
        container.add_child(groupItem);

        const projectGroupItem = this._createButton(
            this._groupByProject ? 'Agrupadas por proyecto' : 'Agrupar por proyecto',
            () => {
                this._groupByProject = !this._groupByProject;
                if (this._groupByProject)
                    this._groupByLabel = false;
                this._refreshDataDialog();
            },
            this._groupByProject ? 'button suggested-action' : 'button'
        );
        container.add_child(projectGroupItem);
    }

    _getLabelButtonStyle({color, textColor}, selected) {
        if (!/^#[0-9a-f]{6}$/i.test(color))
            return '';

        return [
            `background-color: ${color}`,
            `color: ${this._getLabelTextColor({color, textColor})}`,
            'border-radius: 8px',
            'padding: 6px 10px',
            selected ? 'border: 2px solid currentColor' : 'border: 2px solid transparent',
            selected ? 'font-weight: bold' : '',
        ].filter(Boolean).join('; ');
    }

    _getLabelTextColor({color, textColor}) {
        if (/^#[0-9a-f]{6}$/i.test(textColor ?? ''))
            return textColor;

        const rgb = color.slice(1).match(/.{2}/g).map(value => parseInt(value, 16));
        const luminance = (rgb[0] * 299 + rgb[1] * 587 + rgb[2] * 114) / 1000;
        return luminance > 150 ? '#202124' : '#ffffff';
    }

    _createLabelButton(label, callback, color, selected) {
        const button = new St.Button({
            child: new St.Label({
                text: label,
                style: `color: ${this._getLabelTextColor(color)};`,
            }),
            style_class: 'button',
            style: this._getLabelButtonStyle(color, selected),
            can_focus: true,
            reactive: true,
        });
        button.connect('clicked', callback);
        return button;
    }

    _buildIssueList(container, issues, projects) {
        const visibleIssues = this._selectedLabel === null
            ? issues
            : issues.filter(issue => issue.labels?.includes(this._selectedLabel));
        if (visibleIssues.length === 0) {
            const emptyMessage = this._selectedLabel
                ? 'No hay tareas con esta etiqueta'
                : this._polling ? 'Cargando tareas…' : 'No hay tareas abiertas';
            container.add_child(new St.Label({text: emptyMessage, x_expand: true}));
            return;
        }

        const addIssueRow = issue => {
            const row = this._createVerticalBox('padding: 8px;');
            const title = new St.Label({
                text: `#${issue.iid} · ${issue.title}`,
                style_class: 'heading',
                x_expand: true,
            });
            title.clutter_text.set_line_wrap(true);
            row.add_child(title);
            const projectName = issue.project_id
                ? projects?.find(project => project.id === issue.project_id)?.name_with_namespace
                : null;
            const detailRows = [
                ['Proyecto', projectName],
                ['Estado', issue.state],
                ['Etiquetas', issue.labels?.join(', ')],
                ['Asignado a', issue.assignees?.map(assignee => assignee.name).join(', ')],
                ['Autor', issue.author?.name],
                ['Vencimiento', issue.due_date],
                ['Actualizada', issue.updated_at
                    ? new Date(issue.updated_at).toLocaleString()
                    : null],
            ];
            const metadata = detailRows
                .filter(([, value]) => value)
                .map(([name, value]) => `${name}: ${value}`)
                .join('  ·  ');
            if (metadata) {
                const metadataLabel = new St.Label({
                    text: metadata,
                    style_class: 'dim-label',
                    x_expand: true,
                });
                metadataLabel.clutter_text.set_line_wrap(true);
                row.add_child(metadataLabel);
            }

            const actions = this._createHorizontalBox();
            actions.add_child(this._createButton(
                'Ver detalle',
                () => this._showIssueDetails(issue, projectName)
            ));
            actions.add_child(this._createButton(
                'Abrir en GitLab',
                () => Gio.AppInfo.launch_default_for_uri(issue.web_url, null)
            ));
            row.add_child(actions);
            return row;
        };

        if (this._groupByProject) {
            const projectNames = new Map(
                (projects ?? []).map(project => [String(project.id), project.name_with_namespace])
            );
            const groupedIssues = new Map();
            for (const issue of visibleIssues) {
                const projectId = issue.project_id == null ? 'unknown' : String(issue.project_id);
                if (!groupedIssues.has(projectId)) {
                    groupedIssues.set(projectId, {
                        name: projectNames.get(projectId) ??
                            (projectId === 'unknown' ? 'Sin proyecto' : `Proyecto ${projectId}`),
                        issues: [],
                    });
                }
                groupedIssues.get(projectId).issues.push(issue);
            }

            for (const [projectId, project] of groupedIssues) {
                const projectSection = this._createVerticalBox('padding: 8px;', 10);
                const isCollapsed = this._collapsedIssueProjects.has(projectId);
                const projectTitle = new St.Label({
                    text: `${isCollapsed ? '▸' : '▾'} ${project.name} (${project.issues.length})`,
                    x_expand: true,
                });
                projectTitle.clutter_text.set_line_wrap(true);
                const projectToggle = new St.Button({
                    child: projectTitle,
                    style_class: 'button',
                    can_focus: true,
                    reactive: true,
                    x_expand: true,
                });
                const issueRows = this._createVerticalBox('', 10);
                issueRows.visible = !isCollapsed;
                projectToggle.connect('clicked', () => {
                    if (this._collapsedIssueProjects.has(projectId)) {
                        this._collapsedIssueProjects.delete(projectId);
                        projectTitle.text = `▾ ${project.name} (${project.issues.length})`;
                        issueRows.visible = true;
                    } else {
                        this._collapsedIssueProjects.add(projectId);
                        projectTitle.text = `▸ ${project.name} (${project.issues.length})`;
                        issueRows.visible = false;
                    }
                });
                projectSection.add_child(projectToggle);
                for (const issue of project.issues)
                    issueRows.add_child(addIssueRow(issue));
                projectSection.add_child(issueRows);
                container.add_child(projectSection);
            }
            return;
        }

        const groupedIssues = new Map();
        if (this._groupByLabel) {
            for (const issue of visibleIssues) {
                const issueLabels = this._selectedLabel
                    ? [this._selectedLabel]
                    : issue.labels?.length ? issue.labels : ['Sin etiqueta'];
                for (const label of issueLabels) {
                    if (!groupedIssues.has(label))
                        groupedIssues.set(label, []);
                    groupedIssues.get(label).push(issue);
                }
            }
        } else {
            groupedIssues.set(null, visibleIssues);
        }

        for (const [label, groupIssues] of groupedIssues) {
            if (label !== null) {
                container.add_child(new St.Label({
                    text: label,
                    style_class: 'heading',
                    x_expand: true,
                }));
            }
            for (const issue of groupIssues) {
                container.add_child(addIssueRow(issue));
            }
        }
    }

    _buildDeploymentList(container, deployments) {
        if (this._deploymentLoadErrors.length > 0) {
            const error = new St.Label({
                text: `No se pudieron consultar los deploys de ${this._deploymentLoadErrors.length} proyectos. Revisa el registro de GNOME Shell para ver los detalles.`,
                x_expand: true,
            });
            error.clutter_text.set_line_wrap(true);
            container.add_child(error);
        }

        if (deployments.length === 0) {
            container.add_child(new St.Label({
                text: this._polling ? 'Cargando deploys…' : 'Sin deploys recientes',
                x_expand: true,
            }));
            return;
        }

        const projects = new Map();
        for (const deployment of deployments) {
            if (!projects.has(deployment.projectId)) {
                projects.set(deployment.projectId, {
                    id: deployment.projectId,
                    name: deployment.projectName,
                    deployments: [],
                });
            }
            projects.get(deployment.projectId).deployments.push(deployment);
        }

        for (const project of projects.values()) {
            const projectSection = this._createVerticalBox('padding: 8px;', 10);
            const isCollapsed = this._collapsedDeploymentProjects.has(project.id);
            const projectTitle = new St.Label({
                text: `${isCollapsed ? '▸' : '▾'} ${project.name} (${project.deployments.length})`,
                x_expand: true,
            });
            projectTitle.clutter_text.set_line_wrap(true);
            const projectToggle = new St.Button({
                child: projectTitle,
                style_class: 'button',
                can_focus: true,
                reactive: true,
                x_expand: true,
            });
            const deploymentRows = this._createVerticalBox('', 10);
            deploymentRows.visible = !isCollapsed;
            projectToggle.connect('clicked', () => {
                if (this._collapsedDeploymentProjects.has(project.id)) {
                    this._collapsedDeploymentProjects.delete(project.id);
                    projectTitle.text = `▾ ${project.name} (${project.deployments.length})`;
                    deploymentRows.visible = true;
                } else {
                    this._collapsedDeploymentProjects.add(project.id);
                    projectTitle.text = `▸ ${project.name} (${project.deployments.length})`;
                    deploymentRows.visible = false;
                }
            });
            projectSection.add_child(projectToggle);

            for (const deployment of project.deployments) {
                const row = this._createVerticalBox('padding: 8px;');
                const title = new St.Label({
                    text: deployment.environment?.name ?? 'Deploy',
                    style_class: 'dim-label',
                    x_expand: true,
                });
                title.clutter_text.set_line_wrap(true);
                row.add_child(title);
                const manualJobs = deployment.jobs?.filter(job => job.status === 'manual') ?? [];
                const failedJobs = deployment.jobs?.filter(job => job.status === 'failed') ?? [];
                if (deployment.actionsError) {
                    const error = new St.Label({
                        text: `No se pudieron cargar las acciones: ${deployment.actionsError}`,
                        x_expand: true,
                    });
                    error.clutter_text.set_line_wrap(true);
                    row.add_child(error);
                } else if (manualJobs.length === 0 && failedJobs.length === 0) {
                    row.add_child(new St.Label({
                        text: 'No hay jobs manuales pendientes ni fallidos',
                        x_expand: true,
                    }));
                }

                if (manualJobs.length > 0) {
                    row.add_child(new St.Label({
                        text: 'Jobs manuales pendientes',
                        style_class: 'dim-label',
                        x_expand: true,
                    }));
                    for (const job of manualJobs) {
                        row.add_child(this._createButton(
                            `Ejecutar: ${job.name}`,
                            () => this._confirmJobAction(deployment, job, 'play')
                        ));
                    }
                }
                if (failedJobs.length > 0) {
                    row.add_child(new St.Label({
                        text: 'Jobs fallidos',
                        style_class: 'dim-label',
                        x_expand: true,
                    }));
                    for (const job of failedJobs) {
                        row.add_child(this._createButton(
                            `Reintentar: ${job.name}`,
                            () => this._confirmJobAction(deployment, job, 'retry')
                        ));
                    }
                }

                row.add_child(this._createButton(
                    'Abrir deploy en GitLab',
                    () => this._openDeployment(deployment)
                ));
                deploymentRows.add_child(row);
            }
            projectSection.add_child(deploymentRows);
            container.add_child(projectSection);
        }
    }

    _openDeployment(deployment) {
        const projectUrl = deployment.projectWebUrl?.replace(/\/+$/, '');
        const environmentId = deployment.environment?.id;
        const deploymentUrl = projectUrl && environmentId != null && deployment.id != null
            ? `${projectUrl}/-/environments/${encodeURIComponent(environmentId)}/deployments/${encodeURIComponent(deployment.id)}`
            : deployment.deployable?.pipeline?.web_url ?? deployment.deployable_url;
        if (!deploymentUrl) {
            Main.notify('No se pudo abrir el deploy', 'GitLab no proporcionó un enlace para este deploy.');
            return;
        }

        try {
            const launched = Gio.AppInfo.launch_default_for_uri(deploymentUrl, null);
            if (!launched)
                throw new Error('No se encontró una aplicación para abrir el enlace.');
        } catch (error) {
            console.error(`[${this.uuid}] No se pudo abrir el deploy en GitLab: ${error.message}`);
            Main.notify('No se pudo abrir el deploy', error.message);
        }
    }
}
