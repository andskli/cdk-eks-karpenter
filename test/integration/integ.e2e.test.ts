import {  ExpectedResult, IntegTest } from '@aws-cdk/integ-tests-alpha';
import * as cdk from 'aws-cdk-lib';
import { TestKarpenterStack } from './test-stacks';

const cdkApp = new cdk.App();
const karpenterStack = new TestKarpenterStack(cdkApp, 'E2ETestKarpenterStack');

const integ = new IntegTest(cdkApp, 'E2EIntegrationKarpenter', {
  testCases: [karpenterStack],
  diffAssets: true,
  cdkCommandOptions: {
    destroy: {
      args: {
        force: true,
      },
    },
  },
});

integ.assertions
  .awsApiCall('EKS', 'describeCluster', {
    name: karpenterStack.cluster.clusterName,
  })
  .expect(
    ExpectedResult.objectLike({
      cluster: {
        status: 'ACTIVE',
        name: karpenterStack.cluster.clusterName,
      },
    })
  )
  .waitForAssertions({
    totalTimeout: cdk.Duration.minutes(30),
    interval: cdk.Duration.seconds(30),
  });

    // k8sClient = new KubernetesClient(
    //   karpenterStack.cluster.clusterName,
    //   karpenterStack.region,
    // );

    // try {
    //   await k8sClient.initialize();
    // } catch (error) {
    //   throw error;
    // }
  // it('should create Kubernetes inflater deployment', async () => {
  //   await k8sClient.createDeployment('default', {
  //     metadata: {
  //       name: 'inflate',
  //     },
  //     spec: {
  //       selector: {
  //         matchLabels: {
  //           app: 'inflate',
  //         },
  //       },
  //       replicas: 0,
  //       template: {
  //         metadata: {
  //           labels: {
  //             app: 'inflate',
  //           },
  //         },
  //         spec: {
  //           terminationGracePeriodSeconds: 0,
  //           containers: [
  //             {
  //               name: 'inflate',
  //               image: 'public.ecr.aws/eks-distro/kubernetes/pause:3.2',
  //               resources: {
  //                 requests: {
  //                   cpu: '1',
  //                 },
  //               },
  //             },
  //           ],
  //         },
  //       },
  //     } as V1DeploymentSpec,
  //   } as any);
  // });

