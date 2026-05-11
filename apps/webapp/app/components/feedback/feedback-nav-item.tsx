import { useSetAtom } from "jotai";
import { MessageCircleIcon } from "lucide-react";
import { feedbackModalOpenAtom } from "~/atoms/feedback";
import {
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "~/components/layout/sidebar/sidebar";

export default function FeedbackNavItem() {
  const openFeedbackModal = useSetAtom(feedbackModalOpenAtom);
  const { isMobile, setOpenMobile } = useSidebar();

  const handleOpen = () => {
    if (isMobile) {
      setOpenMobile(false);
    }
    openFeedbackModal(true);
  };

  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        className="font-semibold"
        tooltip="Ask a question"
        onClick={handleOpen}
      >
        <MessageCircleIcon className="size-4 text-gray-600" />
        <span>Ask a question</span>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}
