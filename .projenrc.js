const { awscdk, JsonPatch } = require('projen');
const { DependabotScheduleInterval } = require('projen/lib/github');

const PROJECT_NAME = 'cdk-eks-karpenter';

const project = new awscdk.AwsCdkConstructLibrary({
  author: 'Andreas Lindh',
  authorAddress: 'elindh@amazon.com',
  description: 'CDK construct library that allows you install Karpenter in an AWS EKS cluster',
  keywords: ['eks', 'karpenter'],
  defaultReleaseBranch: 'main',
  name: PROJECT_NAME,
  repositoryUrl: 'https://github.com/aws-samples/cdk-eks-karpenter.git',
  cdkVersion: '2.179.0',

  majorVersion: 1,

  deps: [
    '@aws-cdk/cli-lib-alpha',
    '@kubernetes/client-node',
    '@aws-sdk/client-eks',
    '@aws-sdk/client-sts',
    '@aws-sdk/client-cloudformation',
    '@aws-sdk/credential-provider-node',
    '@smithy/protocol-http',
    '@smithy/signature-v4',
    '@aws-crypto/sha256-js',
  ],

  devDeps: [
    '@aws-cdk/lambda-layer-kubectl-v29',
    '@aws-cdk/lambda-layer-kubectl-v30',
    '@aws-cdk/lambda-layer-kubectl-v31',
    '@aws-cdk/integ-tests-alpha',
    '@types/jest',
    '@types/semver',
    'jest',
    'jest-unit',
    'ts-jest',
    '@babel/preset-env',
    '@babel/preset-typescript',
    'babel-jest',
    'jose@^4.14.4',
    'enhanced-resolve',
    'ts-node',
  ],
  bundledDeps: [
    'semver',
  ],

  publishToPypi: {
    distName: PROJECT_NAME,
    module: 'cdk_eks_karpenter',
  },

  experimentalIntegRunner: true,

  jest: true,
  jestOptions: {
    jestConfig: {
      preset: 'ts-jest',
      testEnvironment: 'node',
      resolver: '<rootDir>/jest.resolver.js',
      transformIgnorePatterns: [
        'node_modules/(?!(@kubernetes/client-node|openid-client|oauth4webapi|jose)/.*)',
      ],
      transform: {
        '^.+\\.(ts|tsx)$': 'ts-jest',
        '^.+\\.(js|jsx)$': ['babel-jest', { rootMode: 'upward' }],
      },
      moduleDirectories: ['node_modules', 'src'],
    },
  },


});

// Dependabot configuration
project.dependabot = true;
project.dependabotOptions = {
  scheduleInterval: DependabotScheduleInterval.MONTHLY,
};

// Pull request configuration
project.pullRequestTemplateContents = [
  '---',
  '*By submitting this pull request, I confirm that my contribution is made under the terms of the Apache-2.0 license*',
];

// Patch dependabot configuration to file pull requests against develop branch instead
// dependabot_cfg = project.tryFindObjectFile('.github/dependabot.yml');
// dependabot_cfg.patch(JsonPatch.add('/updates/0/target-branch', 'develop'));

// Excludes
const common_excludes = [
  'cdk.out/',
  'cdk.context.json',
  '.env',
];
project.gitignore.exclude(...common_excludes);
project.npmignore.exclude(...common_excludes);
project.gitignore.exclude(
  'test/integration/*.snapshot/**',
);

// Custom tasks
project.addTask('test:deploy', {
  exec: 'npx cdk deploy -a "npx ts-node -P tsconfig.dev.json --prefer-ts-exts test/integ.karpenter.ts" --all --require-approval=never',
});
project.addTask('test:destroy', {
  exec: 'npx cdk destroy -a "npx ts-node -P tsconfig.dev.json --prefer-ts-exts test/integ.karpenter.ts" --all --force',
});
project.addTask('test:synth', {
  exec: 'npx cdk synth -a "npx ts-node -P tsconfig.dev.json --prefer-ts-exts test/integ.karpenter.ts"',
});
project.addTask('test:e2e', {
  exec: 'npx integ-runner --parallel-regions=eu-west-1 ./test/integration/*.test.ts --update-on-failed',
});

// GitHub actions configuration
project.github.actions.set('actions/download-artifact', 'actions/download-artifact@v4.1.8');
project.github.actions.set('actions/upload-artifact', 'actions/upload-artifact@v4.4.3');
// https://github.com/actions/upload-artifact/issues/602
// build_workflow = project.tryFindObjectFile('.github/workflows/build.yml');
// build_workflow.patch(JsonPatch.add('/jobs/build/steps/5/with/include-hidden-files', true));
// build_workflow.patch(JsonPatch.add('/jobs/build/steps/8/with/include-hidden-files', true));

// release_workflow = project.tryFindObjectFile('.github/workflows/release.yml');
// release_workflow.patch(JsonPatch.add('/jobs/release/steps/7/with/include-hidden-files', true));

project.synth();
