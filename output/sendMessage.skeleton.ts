import { AppEvents, Apps } from '@rocket.chat/apps';
import { Message } from '@rocket.chat/core-services';
import type { IMessage, IRoom } from '@rocket.chat/core-typings';
import { Messages } from '@rocket.chat/models';
import { Match, check } from 'meteor/check';

import { isRelativeURL } from '../../../../lib/utils/isRelativeURL';
import { isURL } from '../../../../lib/utils/isURL';
import { hasPermissionAsync } from '../../../authorization/server/functions/hasPermission';
import { FileUpload } from '../../../file-upload/server';
import { settings } from '../../../settings/server';
import { afterSaveMessage } from '../lib/afterSaveMessage';
import { notifyOnRoomChangedById } from '../lib/notifyListener';
import { validateCustomMessageFields } from '../lib/validateCustomMessageFields';

type SendMessageOptions = {
	upsert?: boolean;
	previewUrls?: string[];
};

// TODO: most of the types here are wrong, but I don't want to change them now

/**
 * IMPORTANT
 *
 * This validator prevents malicious href values
 * intending to run arbitrary js code in anchor tags.
 * You should use it whenever the value you're checking
 * is going to be rendered in the href attribute of a
 * link.
 */
const validFullURLParam = Match.Where((value) => {
	check(value, String);

	if (!isURL(value) && !value.startsWith(FileUpload.getPath())) {
		throw new Error('Invalid href value provided');
	}

	if (/^javascript:/i.test(value)) {
		throw new Error('Invalid href value provided');
	}

	return true;
});

const validPartialURLParam = Match.Where((value) => {
	check(value, String);

	if (!isRelativeURL(value) && !isURL(value) && !value.startsWith(FileUpload.getPath())) {
		throw new Error('Invalid href value provided');
	}

	if (/^javascript:/i.test(value)) {
		throw new Error('Invalid href value provided');
	}

	return true;
});

const objectMaybeIncluding = (types: any) =>
	Match.Where((value: any) => {
		Object.keys(types).forEach((field) => {
			if (value[field] != null) {
				try {
					check(value[field], types[field]);
				} catch (error: any) {
					error.path = field;
					throw error;
				}
			}
		});

		return true;
	});

const validateAttachmentsFields = (attachmentField: any) => {

        /* [GSOC-REDUCTION]: Implementation omitted. */
};

const validateAttachmentsActions = (attachmentActions: any) => {

        /* [GSOC-REDUCTION]: Implementation omitted. */
};

const validateAttachment = (attachment: any) => {

        /* [GSOC-REDUCTION]: Implementation omitted. */
};

const validateBodyAttachments = (attachments: any[]) => attachments.map(validateAttachment);

export const validateMessage = async (message: any, room: any, user: any) => {

        /* [GSOC-REDUCTION]: Implementation omitted. */
};

export function prepareMessageObject(
	message: Partial<IMessage>,
	rid: IRoom['_id'],
	user: { _id: string; username?: string; name?: string },
): asserts message is IMessage {

        /* [GSOC-REDUCTION]: Implementation omitted. */
}

/**
 * Validates and sends the message object. This function does not verify the Message_MaxAllowedSize settings.
 * Caller of the function should verify the Message_MaxAllowedSize if needed.
 * There might be same use cases which needs to override this setting. Example - sending error logs.
 */
export const sendMessage = async function (user: any, message: any, room: any, options: SendMessageOptions = {}) {

        /* [GSOC-REDUCTION]: Implementation omitted. */
};
