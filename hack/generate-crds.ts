import * as yaml from 'js-yaml';
import * as fs from 'fs';
import { execSync } from 'child_process';
import * as os from 'os';
import * as path from 'path';

interface HelmChartConfig {
  repository: string;
  chart: string;
  version: string;
  values?: Record<string, any>;
}

function execCommand(command: string, options: { cwd?: string } = {}) {
  console.log(`\n🔵 Executing command: ${command}`);
  if (options.cwd) {
    console.log(`📂 Working directory: ${options.cwd}`);
  }
  try {
    const output = execSync(command, {
      ...options,
      stdio: 'pipe', // Capture output
      encoding: 'utf-8',
    });
    console.log(`✅ Command succeeded`);
    if (output.trim()) {
      console.log(`📝 Output:\n${output}`);
    }
    return output;
  } catch (error: any) {
    console.error(`❌ Command failed with error:`);
    if (error.stdout) console.error(`📝 stdout:\n${error.stdout}`);
    if (error.stderr) console.error(`❌ stderr:\n${error.stderr}`);
    throw error;
  }
}

async function getTemplatedCRDs(config: HelmChartConfig): Promise<string[]> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-'));
  const chartDir = path.join(tempDir, 'chart');
  
  console.log(`\n📂 Created temporary directory: ${tempDir}`);
  console.log(`📂 Chart directory: ${chartDir}`);
  
  try {
    // For OCI repositories, use helm pull
    if (config.repository.startsWith('oci://')) {
      try {
        execCommand('helm registry logout public.ecr.aws');
      } catch (error) {
        console.log('⚠️ Logout error ignored (expected if not logged in)');
      }

      const chartUrl = `${config.repository}/${config.chart}`;
      execCommand(`helm pull ${chartUrl} --version ${config.version} --destination ${tempDir} --untar --untardir ${chartDir}`);
    } else {
      execCommand(`helm repo add temp-repo ${config.repository}`);
      execCommand('helm repo update');
      execCommand(`helm pull temp-repo/${config.chart} --version ${config.version} --destination ${tempDir} --untar --untardir ${chartDir}`);
      execCommand('helm repo remove temp-repo');
    }

    // List contents of chartDir to debug
    console.log('\n📂 Contents of chart directory:');
    execCommand(`ls -la ${chartDir}`);

    // Template the chart
    let helmCommand = `helm template test ${chartDir}/${config.chart} --include-crds --output-dir ${tempDir}`;
    
    if (config.values) {
      const valuesFile = path.join(tempDir, 'values.yaml');
      console.log(`\n📝 Writing values to: ${valuesFile}`);
      console.log(yaml.dump(config.values));
      fs.writeFileSync(valuesFile, yaml.dump(config.values));
      helmCommand += ` -f ${valuesFile}`;
    }
    
    execCommand(helmCommand);

    // Find all templated files in the output directory
    const crdFiles: string[] = [];
    const templatesDir = path.join(tempDir, `${config.chart}/templates`);
    
    if (fs.existsSync(templatesDir)) {
      console.log(`\n📂 Looking for templates in: ${templatesDir}`);
      
      // Find all yaml files in the templates directory
      fs.readdirSync(templatesDir)
        .filter(file => file.endsWith('.yaml'))
        .forEach(file => {
          const fullPath = path.join(templatesDir, file);
          const content = fs.readFileSync(fullPath, 'utf8');
          // Only include files that are CRDs (have apiVersion: apiextensions.k8s.io/v1)
          if (content.includes('apiVersion: apiextensions.k8s.io/v1')) {
            console.log(`   - ${file}`);
            crdFiles.push(content);
          }
        });
      
      console.log(`📄 Found ${crdFiles.length} CRD files`);
    } else {
      console.log(`⚠️ Templates directory not found at: ${templatesDir}`);
    }

    return crdFiles;
  } finally {
    console.log(`\n🧹 Cleaning up temporary directory: ${tempDir}`);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function generateInterface(properties: any, required: string[] = [], indent: string = ''): string {
  let result = '';
  
  for (const [key, value] of Object.entries(properties)) {
    const prop = value as any;
    const isRequired = required?.includes(key);
    
    // Format description as single-line comments
    if (prop.description) {
      // Split description, clean up whitespace, and add comment prefix
      const description = prop.description
        .split('\n')
        .map((line: string) => line.trim())
        .filter((line: string) => line)
        .map((line: string) => `${indent}// ${line}`)
        .join('\n');
      
      result += `${description}\n`;
    }

    result += `${indent}${key}${isRequired ? '' : '?'}: `;

    if (prop.type === 'object' && prop.properties) {
      // Handle nested objects
      result += '{\n';
      result += generateInterface(prop.properties, prop.required, indent + '  ');
      result += `${indent}};\n`;
    } else if (prop.type === 'array') {
      // Handle arrays
      if (prop.items.type === 'object' && prop.items.properties) {
        result += '{\n';
        result += generateInterface(prop.items.properties, prop.items.required, indent + '  ');
        result += `${indent}}[];\n`;
      } else {
        // Handle primitive arrays and refs
        const itemType = prop.items.$ref ? 
          prop.items.$ref.split('/').pop() : 
          mapType(prop.items.type);
        result += `${itemType}[];\n`;
      }
    } else if (prop.$ref) {
      // Handle references
      result += `${prop.$ref.split('/').pop()};\n`;
    } else {
      // Handle primitive types
      result += `${mapType(prop.type)};\n`;
    }
  }
  
  return result;
}


function mapType(type: string): string {
  const typeMap: Record<string, string> = {
    'string': 'string',
    'integer': 'number',
    'number': 'number',
    'boolean': 'boolean',
    'object': 'Record<string, any>',
    'array': 'any[]'
  };
  
  return typeMap[type] || 'any';
}

async function generateTypesFromHelmChart(config: HelmChartConfig, outputDir: string) {
  const crdContents = await getTemplatedCRDs(config);
  
  for (const crdContent of crdContents) {
    const crd = yaml.load(crdContent) as any;
    
    if (!crd?.spec?.versions?.[0]?.schema?.openAPIV3Schema) {
      console.warn(`Skipping CRD ${crd?.metadata?.name} - missing schema`);
      continue;
    }

    const schema = crd.spec.versions[0].schema.openAPIV3Schema;
    const interfaceName = crd.spec.names.kind;
    
    let content = '// Auto-generated TypeScript interfaces from CRD\n\n';
    content += `export interface ${interfaceName} {\n`;
    content += generateInterface(schema.properties, schema.required, '  ');
    content += '}\n';

    const outputPath = path.join(outputDir, `${interfaceName.toLowerCase()}.ts`);
    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(outputPath, content);
    console.log(`Generated interface for ${interfaceName} at ${outputPath}`);
  }
}

// Usage example:
const config: HelmChartConfig = {
  repository: 'oci://public.ecr.aws/karpenter',
  chart: 'karpenter-crd',
  version: '1.3.0',
  values: {
    // Optional values to pass to helm template
  }
};

generateTypesFromHelmChart(config, './types')
  .catch(console.error);
