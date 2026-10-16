import { validateIssueFormDefinitions } from './issue-forms.mjs';

const { errors, formCount } = await validateIssueFormDefinitions();
if (errors.length > 0) {
    console.error('Issue form validation failed:');
    for (const error of errors) {
        console.error(`- ${error}`);
    }
    process.exitCode = 1;
} else {
    console.log(`Validated ${formCount} issue forms and their chooser configuration.`);
}
