import { KubectlV31Layer } from '@aws-cdk/lambda-layer-kubectl-v31';
import { Stack, StackProps } from 'aws-cdk-lib';
import { Vpc } from 'aws-cdk-lib/aws-ec2';
import { AuthenticationMode, Cluster, KubernetesVersion, NodegroupAmiType, TaintEffect } from 'aws-cdk-lib/aws-eks';
import { ManagedPolicy, Role, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import { Karpenter } from '../../src';

export interface TestKarpenterStackProps extends StackProps {
  readonly vpc: Vpc;
}

export class TestKarpenterStack extends Stack {
  public readonly vpc: Vpc;
  public readonly cluster: Cluster;

  constructor(scope: Construct, id: string) {
    super(scope, id);

    this.vpc = new Vpc(this, 'VPC', {
      natGateways: 1,
    });

    const clusterRole = new Role(this, 'clusterRole', {
      assumedBy: new ServicePrincipal('eks.amazonaws.com'),
      managedPolicies: [
        ManagedPolicy.fromAwsManagedPolicyName('AmazonEKSClusterPolicy'),
        ManagedPolicy.fromAwsManagedPolicyName('AmazonEKSVPCResourceController'),
      ],
    });

    const kubectlLayer = new KubectlV31Layer(this, 'KubectlLayer');

    this.cluster = new Cluster(this, 'cluster', {
      vpc: this.vpc,
      role: clusterRole,
      version: KubernetesVersion.V1_31, // OCI HELM repo only supported by new version.
      defaultCapacity: 0,
      kubectlLayer: kubectlLayer,
      authenticationMode: AuthenticationMode.API,
    });

    this.cluster.addNodegroupCapacity('system-nodes', {
      amiType: NodegroupAmiType.BOTTLEROCKET_X86_64,
      minSize: 0,
      maxSize: 2,
      desiredSize: 1,
      taints: [
        {
          effect: TaintEffect.NO_SCHEDULE,
          key: 'CriticalAddonsOnly',
          value: 'true',
        },
      ],
    });

    const karpenter = new Karpenter(this, 'Karpenter', {
      cluster: this.cluster,
      version: '1.1.1', // test a recent version
      helmExtraValues: {
        tolerations: [
          {
            key: 'CriticalAddonsOnly',
            operator: 'Exists',
          },
        ],
      },
    });

    const nodeClass = karpenter.addEC2NodeClass('nodeclass', {
      amiFamily: 'Bottlerocket',
      amiSelectorTerms: [
        {
          alias: 'bottlerocket@latest',
        },
      ],
      subnetSelectorTerms: [
        {
          tags: {
            Name: `${this.stackName}/${this.vpc.node.id}/PrivateSubnet*`,
          },
        },
      ],
      securityGroupSelectorTerms: [
        {
          tags: {
            'aws:eks:cluster-name': this.cluster.clusterName,
          },
        },
      ],
      role: karpenter.nodeRole.roleName,
    });

    karpenter.addNodePool('nodepool', {
      template: {
        spec: {
          nodeClassRef: {
            group: 'karpenter.k8s.aws',
            kind: 'EC2NodeClass',
            name: nodeClass.name,
          },
          requirements: [
            {
              key: 'karpenter.k8s.aws/instance-category',
              operator: 'In',
              values: ['m'],
            },
            {
              key: 'kubernetes.io/arch',
              operator: 'In',
              values: ['amd64'],
            },
          ],
        },
      },
    });

    karpenter.addManagedPolicyToKarpenterRole(ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'));
  }
}
