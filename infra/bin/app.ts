// One stack: the DynamoDB table that holds game state, the execution role, and
// the Web Function (function + revision + endpoint).
//
// Web Functions have L1 constructs only today (CfnWebFunction,
// CfnWebFunctionRevision, CfnWebFunctionEndpoint), so the role and code asset
// are wired up by hand. Swap these three for the L2 construct when it ships.

import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { App, CfnOutput, Duration, Fn, RemovalPolicy, Stack, StackProps, Tags } from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import { Construct } from 'constructs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

class FreedoomStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);
    const functionName = 'freedoom-on-lambda';

    // pk = game#<id>, sk = lease | log#<tic> | in#<...>. See server/store.js.
    const table = new dynamodb.TableV2(this, 'Games', {
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      billing: dynamodb.Billing.onDemand(),
      timeToLiveAttribute: 'expiresAt',
      removalPolicy: RemovalPolicy.DESTROY, // demo data only
    });

    const logGroup = new logs.LogGroup(this, 'Logs', {
      logGroupName: `/aws/lambda/web/${functionName}`,
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const role = new iam.Role(this, 'ExecutionRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
    });
    // The platform also writes a <group>.local copy in the Region that served the request.
    role.addToPolicy(new iam.PolicyStatement({
      actions: ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents'],
      resources: [
        `arn:${this.partition}:logs:${this.region}:${this.account}:log-group:/aws/lambda/web/${functionName}*`,
        `arn:${this.partition}:logs:${this.region}:${this.account}:log-group:/aws/lambda/web/${functionName}*:*`,
      ],
    }));
    table.grant(role, 'dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:Query');
    // TransactWriteItems is authorised per item, by the Put/Update actions above,
    // plus ConditionCheck for completeness.
    table.grant(role, 'dynamodb:ConditionCheckItem');

    // Set -c webFunction=false to deploy only the table, role and log group,
    // and deploy the function with `aws lambda-web deploy` instead, with the
    // role ARN and table name from the outputs. Only needed in an account whose
    // CloudFormation still resolves AWS::Lambda::WebFunction to the
    // preview-era schema.
    if (this.node.tryGetContext('webFunction') === 'false') {
      new CfnOutput(this, 'ExecutionRoleArn', { value: role.roleArn });
      new CfnOutput(this, 'TableName', { value: table.tableName });
      new CfnOutput(this, 'LogGroupName', { value: logGroup.logGroupName });
      return;
    }

    // Code bucket. The Web Functions service reads the package as
    // lambda.amazonaws.com, so the bucket grants it read access for this
    // account only (the same policy `aws lambda-web deploy` puts on its
    // managed bucket). The CDK bootstrap bucket can't be used directly: it is
    // KMS-encrypted and grants no service principal.
    const codeBucket = new s3.Bucket(this, 'CodeBucket', {
      versioned: true,
      enforceSSL: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });
    codeBucket.addToResourcePolicy(new iam.PolicyStatement({
      principals: [new iam.ServicePrincipal('lambda.amazonaws.com')],
      actions: ['s3:GetObject', 's3:GetObjectVersion'],
      resources: [codeBucket.arnForObjects('*')],
      conditions: { StringEquals: { 'aws:SourceAccount': this.account } },
    }));

    // server/ zipped by `cdk deploy` (about 30 MB, mostly the WAD) and copied
    // into the code bucket as a single zip. The key is the content hash, so new
    // code means a new key and therefore a new revision.
    const code = s3deploy.Source.asset(path.join(HERE, '..', '..', 'server'));
    const upload = new s3deploy.BucketDeployment(this, 'UploadCode', {
      sources: [code],
      destinationBucket: codeBucket,
      extract: false,
      prune: false,
      memoryLimit: 1024,
    });
    const codeKey = Fn.select(0, upload.objectKeys);

    const fn = new lambda.CfnWebFunction(this, 'WebFunction', { functionName });

    const revision = new lambda.CfnWebFunctionRevision(this, 'Revision', {
      functionName: fn.functionName,
      buildConfig: {
        runtimeConfig: { runtime: 'nodejs24.x' },
        codeConfig: { s3Object: { bucket: upload.deployedBucket.bucketName, key: codeKey } },
      },
      serviceConfig: {
        executionRoleArn: role.roleArn,
        timeoutSeconds: Duration.minutes(15).toSeconds(), // the maximum: one stream lasts up to 15 minutes
        environmentVariables: { TABLE_NAME: table.tableName },
        telemetryConfig: { loggingConfig: { logGroup: logGroup.logGroupName } },
      },
    });
    revision.addDependency(fn);
    revision.node.addDependency(role, upload);

    // Default: public, anyone with the URL can play, and the limits below cap
    // the cost. Set -c auth=iam when the endpoint sits behind CloudFront: the
    // endpoint then only accepts SigV4-signed requests, and a resource policy
    // (added by whatever stack owns the distribution) lets CloudFront's origin
    // access control sign for viewers.
    const iamAuth = this.node.tryGetContext('auth') === 'iam';

    const endpoint = new lambda.CfnWebFunctionEndpoint(this, 'Endpoint', {
      functionName: fn.functionName,
      endpointName: 'live',
      endpointType: 'HomeRegion',
      authType: iamAuth ? 'IamAuth' : 'ApplicationManaged',
      revisionWeights: [{ revisionId: revision.attrRevisionId, weight: 100 }],
      scalingConfig: { maxEnvironments: 2 },
      throttleConfig: { rateLimit: 100 },
    });
    endpoint.addDependency(fn);

    new CfnOutput(this, 'Url', { value: `https://${endpoint.attrDomainName}` });
    new CfnOutput(this, 'EndpointDomainName', { value: endpoint.attrDomainName });
    new CfnOutput(this, 'EndpointArn', { value: endpoint.attrEndpointArn });
    new CfnOutput(this, 'FunctionArn', { value: fn.attrFunctionArn });
    new CfnOutput(this, 'AuthType', { value: iamAuth ? 'IamAuth' : 'ApplicationManaged' });
    new CfnOutput(this, 'TableName', { value: table.tableName });
    new CfnOutput(this, 'LogGroupName', { value: logGroup.logGroupName });
  }
}

const app = new App();
const stack = new FreedoomStack(app, 'FreedoomOnLambda', {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION ?? 'us-east-1' },
});
Tags.of(stack).add('project', 'freedoom-lambda-web-functions');
