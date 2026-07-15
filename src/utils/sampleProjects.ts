/**
 * Sample Gerber projects bundled from the /samples folder. Each subfolder is
 * one project; only the CAM-relevant files are loaded: top copper, bottom
 * copper, board outline (cutout) and drill.
 */
const sampleFiles = import.meta.glob('../../samples/*/*', {
  query: '?raw',
  import: 'default',
}) as Record<string, () => Promise<string>>;

const RELEVANT_PATTERNS: RegExp[] = [
  /f_cu|f\.cu|top.*copper|\.gtl$/i, // top copper
  /b_cu|b\.cu|bottom.*copper|\.gbl$/i, // bottom copper
  /edge_cuts|edge\.cuts|outline|\.gko$|\.gm1$/i, // board outline / cutout
  /\.drl$|\.xln$|\.drd$/i, // drill
];

export interface SampleProject {
  name: string;
  files: Array<{ name: string; load: () => Promise<string> }>;
}

export function listSampleProjects(): SampleProject[] {
  const byProject = new Map<string, SampleProject>();
  for (const [path, load] of Object.entries(sampleFiles)) {
    const parts = path.split('/');
    const fileName = parts[parts.length - 1];
    const projectName = parts[parts.length - 2];
    if (!RELEVANT_PATTERNS.some((re) => re.test(fileName))) continue;
    let project = byProject.get(projectName);
    if (!project) {
      project = { name: projectName, files: [] };
      byProject.set(projectName, project);
    }
    project.files.push({ name: fileName, load });
  }
  return [...byProject.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Load a sample project's files as File objects for the normal import flow. */
export async function loadSampleProjectFiles(project: SampleProject): Promise<File[]> {
  return Promise.all(
    project.files.map(async (f) => new File([await f.load()], f.name, { type: 'text/plain' })),
  );
}
