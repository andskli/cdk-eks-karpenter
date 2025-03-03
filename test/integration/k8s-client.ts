import { Sha256 } from '@aws-crypto/sha256-js';
import { DescribeClusterCommand, EKSClient } from '@aws-sdk/client-eks';
import { STSClient } from '@aws-sdk/client-sts';
import { KubeConfig, CoreV1Api, AppsV1Api, V1PodList, V1Deployment, V1Status, V1Scale } from '@kubernetes/client-node';
import { SignatureV4 } from '@smithy/signature-v4';

interface Token {
  value?: string;
  expiration?: Date;
}

export class KubernetesClient {
  private static readonly TOKEN_EXPIRY_MINUTES = 10;
  private static readonly STS_TOKEN_EXPIRES_IN = 60;

  private kubeConfig?: KubeConfig;
  private coreV1Api?: CoreV1Api;
  private appsV1Api?: AppsV1Api;
  private stsClient: STSClient;

  private clusterEndpoint: string = '';
  private clusterCaData: string = '';
  private token: Token = {};

  private readonly clusterName: string;
  private readonly region: string;

  private refreshInterval?: NodeJS.Timer;

  constructor(clusterName: string, region: string) {
    this.clusterName = clusterName;
    this.region = region;
    this.stsClient = new STSClient({ region: this.region });
  };

  async initialize(): Promise<void> {
    const eksClient = new EKSClient();
    const cluster = await eksClient.send(new DescribeClusterCommand({
      name: this.clusterName,
    }));

    if (!cluster.cluster?.endpoint || !cluster.cluster?.certificateAuthority?.data) {
      throw new Error('Unable to get EKS cluster information');
    }

    this.clusterCaData = cluster.cluster.certificateAuthority.data;
    this.clusterEndpoint = cluster.cluster.endpoint;

    this.token = await this.getToken();

    this.kubeConfig = this.createKubeConfig(this.clusterEndpoint, this.clusterCaData);
    // console.log('DEBUG: ', this.kubeConfig);

    // Initialize API clients
    this.coreV1Api = this.kubeConfig.makeApiClient(CoreV1Api);
    this.appsV1Api = this.kubeConfig.makeApiClient(AppsV1Api);

    this.startTokenRefreshInterval();
  }

  private createKubeConfig(endpoint: string, caData: string): KubeConfig {
    const kubeConfig = new KubeConfig();

    kubeConfig.loadFromOptions({
      clusters: [{
        name: this.clusterName,
        server: endpoint,
        caData: caData,
      }],
      users: [{
        name: 'aws',
        token: this.token.value,
      }],
      contexts: [{
        name: this.clusterName,
        cluster: this.clusterName,
        user: 'aws',
      }],
      currentContext: this.clusterName,
    });

    return kubeConfig;
  }

  private startTokenRefreshInterval(): void {
    this.stopTokenRefreshInterval();

    const refreshIntervalMs =
      (KubernetesClient.TOKEN_EXPIRY_MINUTES * 60 * 1000) / 2;

    this.refreshInterval = setInterval(async () => {
      try {
        const oldToken = this.token;
        await this.refreshToken();

        // Only recreate kubeConfig if token actually changed
        if (oldToken.value !== this.token.value && this.kubeConfig) {
          // Recreate kubeConfig with new token
          const cluster = this.kubeConfig.clusters[0];
          if (cluster?.server && cluster?.caData) {
            this.kubeConfig = this.createKubeConfig(
              cluster.server,
              cluster.caData,
            );
            // Reinitialize API clients with new config
            this.coreV1Api = this.kubeConfig.makeApiClient(CoreV1Api);
            this.appsV1Api = this.kubeConfig.makeApiClient(AppsV1Api);
          }
        }
      } catch (error) {
        console.error('Failed to refresh token:', error);
      }
    }, refreshIntervalMs);

    this.refreshInterval.unref();
  }


  private stopTokenRefreshInterval(): void {
    if (this.refreshInterval) {
      clearInterval(this.refreshInterval);
      this.refreshInterval = undefined;
    }
  }

  private async withAutoRefresh<T>(operation: () => Promise<T>): Promise<T> {
    await this.refreshToken();
    try {
      return await operation();
    } catch (error) {
      if (error instanceof Error &&
        'response' in error &&
        (error as any).response?.statusCode === 401) {
        this.token = {};
        await this.refreshToken();
        return operation();
      }
      throw error;
    }
  }


  // Gets a token and returns it as string
  // THANKS: https://github.com/aws/aws-sdk-js/issues/2833#issuecomment-996220521
  private async getToken(): Promise<Token> {
    const signer = new SignatureV4({
      service: 'sts',
      region: this.region,
      credentials: await this.stsClient.config.credentials(),
      sha256: Sha256,
    });

    const signedRequest = await signer.presign({
      method: 'GET',
      protocol: 'https:',
      hostname: `sts.${this.region}.amazonaws.com`,
      path: '/',
      query: {
        Action: 'GetCallerIdentity',
        Version: '2011-06-15',
      },
      headers: {
        'host': `sts.${this.region}.amazonaws.com`,
        'x-k8s-aws-id': this.clusterName,
      },
    }, {
      expiresIn: KubernetesClient.STS_TOKEN_EXPIRES_IN,
    });

    const query = Object.keys(signedRequest?.query ?? {})
      .map(
        (q) =>
          encodeURIComponent(q) +
          '=' +
          encodeURIComponent(signedRequest.query?.[q] as string),
      )
      .join('&');

    const url = `https://${signedRequest.hostname}${signedRequest.path}?${query}`;

    const token: Token = {
      value: 'k8s-aws-v1.' + Buffer.from(url).toString('base64url'),
      expiration: new Date(Date.now() + KubernetesClient.TOKEN_EXPIRY_MINUTES * 60 * 1000),
    };

    return token;
  }

  private async refreshToken(): Promise<void> {
    const now = new Date();
    // Add buffer time (30 seconds) to prevent token expiration during requests
    const bufferTime = 30 * 1000;

    if (!this.token.expiration ||
      now.getTime() >= (this.token.expiration.getTime() - bufferTime)) {
      this.token = await this.getToken();
    }
  }


  // Add a dispose method for cleanup
  async dispose(): Promise<void> {
    this.stopTokenRefreshInterval();
    this.token = {};
    this.kubeConfig = undefined;
    this.coreV1Api = undefined;
    this.appsV1Api = undefined;
  }

  async listPods(namespace: string = 'default'): Promise<V1PodList> {
    return this.withAutoRefresh(() =>
      this.coreV1Api!.listNamespacedPod({
        namespace: namespace,
      }),
    ).then(response => response);
  }

  async createDeployment(namespace: string = 'default', deployment: V1Deployment): Promise<V1Deployment> {
    return this.withAutoRefresh(() => {
      return this.appsV1Api!.createNamespacedDeployment({
        namespace: namespace,
        body: deployment,
      });
    }).then(response => response);
  }

  async deleteDeployment(namespace: string = 'default', deploymentName: string): Promise<V1Status> {
    return this.withAutoRefresh(() => {
      return this.appsV1Api!.deleteNamespacedDeployment({
        namespace: namespace,
        name: deploymentName,
      });
    }).then(response => response);
  }

  async scaleDeployment(
    namespace: string = 'default',
    deploymentName: string,
    replicas: number): Promise<V1Scale> {
    return this.withAutoRefresh(() => {
      return this.appsV1Api!.patchNamespacedDeploymentScale({
        namespace: namespace,
        name: deploymentName,
        body: {
          spec: {
            replicas: replicas,
          },
        },
      });
    }).then(response => response);
  }

  tokenValue(): string | undefined {
    return this.token.value;
  }
}

// TODO: Cleanup
// async function main() {
//   const client = new KubernetesClient('lab-cluster', 'eu-west-1');
//   try {
//     await client.initialize();
//     const pods = await client.listPods('kube-system');
//     console.log(pods);
//   } catch (error) {
//     console.error(error);
//   } finally {
//     await client.dispose();
//   }
// }
//
// main().catch(console.error);
