import type { IMessage } from '@rocket.chat/core-typings';

import { processMessageEditing } from './processMessageEditing';
import { processSetReaction } from './processSetReaction';
import { processSlashCommand } from './processSlashCommand';
import { processTooLongMessage } from './processTooLongMessage';
import { sdk } from '../../../../app/utils/client/lib/SDKClient';
import { t } from '../../../../app/utils/lib/i18n';
import { closeUnclosedCodeBlock } from '../../../../lib/utils/closeUnclosedCodeBlock';
import { Messages } from '../../../stores';
import { onClientBeforeSendMessage } from '../../onClientBeforeSendMessage';
import { dispatchToastMessage } from '../../toast';
import type { ChatAPI } from '../ChatAPI';

const process = async (chat: ChatAPI, message: IMessage, previewUrls?: string[], isSlashCommandAllowed?: boolean): Promise<void> => {

        /* [GSOC-REDUCTION]: Implementation omitted. */
};

export const sendMessage = async (
	chat: ChatAPI,
	{
		text,
		tshow,
		previewUrls,
		isSlashCommandAllowed,
	}: { text: string; tshow?: boolean; previewUrls?: string[]; isSlashCommandAllowed?: boolean },
): Promise<boolean> => {

        /* [GSOC-REDUCTION]: Implementation omitted. */
};
