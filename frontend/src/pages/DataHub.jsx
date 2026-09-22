import React from 'react';
import FeaturePlaceholder from '../components/ui/FeaturePlaceholder';
import { PAGE_STATUS_BY_KEY } from '../config/pageRegistry';

export default function DataHub() {
    const page = PAGE_STATUS_BY_KEY.datahub;

    return (
        <FeaturePlaceholder
            code={`PAGE ${page.shortcut} // DATA HUB`}
            title={page.titleZh}
            subtitle={page.titleEn}
            status={page.status}
            description={page.summary}
            availableNow={page.availableNow}
            nextSteps={page.nextSteps}
        />
    );
}
